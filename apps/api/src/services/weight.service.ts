import type {
  CreateWeightEntry,
  DateRangeQuery,
  UpdateWeightEntry,
  WeightEntry,
  WeightSource,
} from "shared";
import {
  toNumber,
  toNumberOrNull,
  toNumeric,
  toNumericOrNull,
  weightSourceSchema,
} from "shared";
import type { Db } from "../db/index.js";
import {
  deleteWeightEntry,
  deleteWeightForDayExcept,
  findWeightById,
  findWeightForDay,
  listWeightEntries,
  updateWeightRow,
  upsertWeightByClientUuid,
  type WeightRow,
} from "../repositories/weight.repo.js";
import { conflict, notFound } from "../lib/errors.js";
import { detectMilestones } from "./progress.service.js";
import { assertDateSource, serverDate } from "../lib/date-source.js";

/**
 * Weight logging.
 *
 * `userId` first, always (CLAUDE.md §3). `localDate` comes from the client and
 * is written through untouched — the server never computes a day bucket from a
 * timestamp, because a 23:40 reading in Stockholm belongs to that day and not
 * to whatever UTC says.
 */

/** Rows cross the repository boundary as strings; numbers start here. */
/** Rows written before the enum existed read as manual entries. */
function toWeightSource(value: string): WeightSource {
  return weightSourceSchema.catch("manual").parse(value);
}

function toEntry(row: WeightRow): WeightEntry {
  return {
    id: row.id,
    clientUuid: row.clientUuid,
    localDate: row.localDate,
    loggedAt: row.loggedAt.toISOString(),
    weightKg: toNumber(row.weightKg),
    bodyFatPct: toNumberOrNull(row.bodyFatPct),
    source: toWeightSource(row.source),
    note: row.note,
  };
}

/**
 * Idempotent. Replaying the same `clientUuid` updates that row; a *different*
 * uuid on a day that already has a reading replaces it, because the schema
 * holds one canonical reading per day.
 *
 * Both steps run in one transaction, so a replay can never land between the
 * delete and the insert and leave the day empty.
 */
export async function saveWeightEntry(
  userId: string,
  db: Db,
  input: CreateWeightEntry,
): Promise<WeightEntry> {
  /**
   * The date and where it came from have to agree (D61). Checked here rather
   * than in the schema, because the answer depends on the server's own clock
   * and a Zod refinement cannot see it.
   */
  assertDateSource(input.localDate, input.dateSource, serverDate());

  /**
   * D41. The day is unique, so two devices writing it means one of them loses.
   * Which one is decided by a stated rule rather than by arrival order:
   *
   *  - a **live** write replaces the day. The user is looking at the current
   *    value and chose to change it;
   *  - a **queued** write does not. It was composed before the other device's
   *    reading existed, so it cannot have been a decision to replace it. It is
   *    refused with 409 and both readings are shown, and the user picks.
   *
   * Replaying the *same* `clientUuid` is never a conflict: that is the same
   * write arriving twice, which is the whole point of the idempotency key.
   */
  if (input.fromQueue === true) {
    const occupied = await findWeightForDay(userId, db, input.localDate);

    if (occupied !== null && occupied.clientUuid !== input.clientUuid) {
      throw conflict(
        "day_already_written",
        "Den här dagen har redan en vägning från en annan enhet. " +
          "Välj vilken som ska gälla.",
        {
          existing: {
            clientUuid: occupied.clientUuid,
            localDate: occupied.localDate,
            weightKg: toNumber(occupied.weightKg),
            loggedAt: occupied.loggedAt.toISOString(),
          },
        },
      );
    }
  }

  const row = await db.transaction(async (tx) => {
    await deleteWeightForDayExcept(userId, tx, input.localDate, input.clientUuid);

    return upsertWeightByClientUuid(userId, tx, {
      clientUuid: input.clientUuid,
      localDate: input.localDate,
      loggedAt: input.loggedAt ? new Date(input.loggedAt) : new Date(),
      weightKg: toNumeric(input.weightKg, 2),
      bodyFatPct: toNumericOrNull(input.bodyFatPct, 1),
      source: input.source,
      note: input.note ?? null,
    });
  });

  /**
   * Detection runs **on write**, against the trend the new reading produces,
   * never against the reading itself: one dehydrated morning can put the scale
   * two kilos under where the body is, and a milestone that fires on that is a
   * milestone that fires on nothing.
   *
   * Outside the transaction above on purpose. A milestone stamp is not part of
   * the weight write, and a failure to detect must not roll back the reading
   * the user just took, which is the thing they actually asked to store.
   */
  await detectMilestones(userId, db, input.localDate);

  return toEntry(row);
}

/**
 * Changing a reading that already exists (D150).
 *
 * A different operation from creating one, and the reason is a defect rather
 * than tidiness. The edit sheet used to enqueue a **create** with a fresh
 * `clientUuid`, so editing 24 August from 110,0 to 110,1 arrived as a queued
 * write for a day another uuid already held. D41's rule fired correctly and the
 * page said "two devices wrote this day" about one device editing its own
 * reading, and the queued row's "Försök igen" could never succeed because
 * sending the identical bytes got the identical answer.
 *
 * No wording could have fixed that. The request did not say what it was, so the
 * server could not tell an edit from a second opinion.
 *
 * What an update carries is the row's id and **the value the client had on
 * screen**. Three outcomes, and only the last one is a question for a person:
 *
 *  - the row is gone: 404. Somebody deleted it, here or elsewhere;
 *  - the row still holds the baseline: applied, whether it came from the queue
 *    or not. A queued edit replaying against an unchanged row is not a
 *    collision, it is the edit arriving late;
 *  - the row holds something else: 409 `changed_since`, carrying what is
 *    stored so the client can show both without a second round trip.
 *
 * Moving a reading to a day that already has one is the remaining same-day
 * clash, and it keeps D41's own code so the page's wording stays true.
 */
export async function updateWeightEntry(
  userId: string,
  db: Db,
  input: UpdateWeightEntry,
): Promise<WeightEntry> {
  assertDateSource(input.localDate, input.dateSource, serverDate());

  const row = await findWeightById(userId, db, input.id);

  /**
   * The row is gone, which has two quite different causes.
   *
   * A live write from another device **replaces** the day rather than updating
   * the row: `deleteWeightForDayExcept` removes the old uuid and inserts a new
   * one (D41). So the id an edit is holding disappears in exactly the case the
   * person most needs told about, and a bare 404 would say "that reading does
   * not exist" while the day plainly has one.
   *
   * So: a day that still holds a reading is the changed-under-you case and gets
   * the 409 with what is stored. A day with nothing on it is a real deletion.
   */
  if (row === null) {
    const occupant = await findWeightForDay(userId, db, input.localDate);
    if (occupant === null) {
      throw notFound("Den vägningen finns inte längre.");
    }

    throw conflict(
      "changed_since",
      "Den här vägningen har ändrats någon annanstans sedan du öppnade den. " +
        "Välj vilken som ska gälla.",
      {
        existing: {
          clientUuid: occupant.clientUuid,
          localDate: occupant.localDate,
          weightKg: toNumber(occupant.weightKg),
          loggedAt: occupant.loggedAt.toISOString(),
        },
      },
    );
  }

  /**
   * The baseline, compared as a number.
   *
   * `numeric` crosses the repository boundary as a string, so "110.00" and
   * "110" are the same reading and a string comparison would call that a
   * conflict. Rounded to the two decimals the column stores, because the client
   * saw what the column holds.
   */
  const stored = Math.round(toNumber(row.weightKg) * 100) / 100;
  const baseline = Math.round(input.baselineWeightKg * 100) / 100;

  if (stored !== baseline) {
    throw conflict(
      "changed_since",
      "Den här vägningen har ändrats någon annanstans sedan du öppnade den. " +
        "Välj vilken som ska gälla.",
      {
        existing: {
          clientUuid: row.clientUuid,
          localDate: row.localDate,
          weightKg: stored,
          loggedAt: row.loggedAt.toISOString(),
        },
      },
    );
  }

  /**
   * Moving a reading onto a day that already has one is the same-day case D41
   * is about, and it keeps that code and that message: two readings exist for
   * one day and a person has to say which.
   */
  if (input.localDate !== row.localDate) {
    const occupied = await findWeightForDay(userId, db, input.localDate);
    if (occupied !== null && occupied.id !== row.id) {
      throw conflict(
        "day_already_written",
        "Den dagen har redan en vägning. Välj vilken som ska gälla.",
        {
          existing: {
            clientUuid: occupied.clientUuid,
            localDate: occupied.localDate,
            weightKg: toNumber(occupied.weightKg),
            loggedAt: occupied.loggedAt.toISOString(),
          },
        },
      );
    }
  }

  const updated = await updateWeightRow(userId, db, input.id, {
    localDate: input.localDate,
    weightKg: toNumeric(input.weightKg, 2),
    bodyFatPct: toNumericOrNull(input.bodyFatPct, 1),
    note: input.note ?? null,
    /**
     * Re-stamped, because the reading was taken again in the only sense that
     * matters here: somebody looked at it and said it was something else.
     */
    loggedAt: new Date(),
  });

  if (updated === null) throw notFound("Den vägningen finns inte längre.");

  // Same reason as the create: the trend moved, so a milestone may have been
  // reached or un-reached, and detection reads the smoothed series (D32).
  await detectMilestones(userId, db, updated.localDate);

  return toEntry(updated);
}

/**
 * Removes a reading.
 *
 * Everything downstream is recomputed from the remaining rows on the next read:
 * the trend, the projections, maintenance, the milestone states. Nothing is
 * stored derived, which is what makes this a delete rather than a migration.
 *
 * Deliberately **not** re-running milestone detection. An already-achieved
 * milestone stays achieved (D8): deleting the reading that triggered it does
 * not un-happen the day it was reached, and revoking one would be the "you
 * ruined it" failure state §3 rules out.
 */
export async function removeWeightEntry(
  userId: string,
  db: Db,
  id: string,
): Promise<void> {
  if (!(await deleteWeightEntry(userId, db, id))) {
    throw notFound("Det finns ingen sådan vägning.");
  }
}

export async function getWeightEntries(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<WeightEntry[]> {
  const rows = await listWeightEntries(userId, db, range);
  return rows.map(toEntry);
}
