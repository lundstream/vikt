import type {
  CreateWeightEntry,
  DateRangeQuery,
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
  findWeightForDay,
  listWeightEntries,
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
