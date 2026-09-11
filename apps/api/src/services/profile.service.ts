import type { AuthedUser } from "./auth.service.js";
import type { UpdateProfile } from "shared";
import { exerciseAdjustment, toNumericOrNull } from "shared";
import type { Db } from "../db/index.js";
import { updateProfile as updateProfileRow } from "../repositories/users.repo.js";
import { getMe } from "./auth.service.js";
import { currentMaintenance } from "./insights.service.js";
import { notFound, unprocessable } from "../lib/errors.js";

/**
 * Profile edits.
 *
 * The dashboard sends only the fields it asked for, so every one is optional
 * and an absent key means "leave it alone" — distinct from an explicit `null`
 * on `birthDate`, which clears it.
 *
 * One field is refused rather than merely defaulted off: see below.
 */
export async function editProfile(
  userId: string,
  db: Db,
  input: UpdateProfile,
): Promise<AuthedUser> {
  /**
   * D31. Turning this on while maintenance is adaptive is refused here, not
   * only greyed out in the UI — "unavailable, not merely default off" has to
   * hold at the API or it does not hold at all. An adaptive figure is derived
   * from what actually happened to the trend line, so it already contains every
   * calorie burned training; adding them again is a double count that grows
   * with training volume.
   */
  if (input.addExerciseToTarget === true) {
    const maintenance = await currentMaintenance(userId, db);
    const adjustment = exerciseAdjustment(true, maintenance.source);

    if (!adjustment.available) {
      throw unprocessable(
        adjustment.reason,
        adjustment.reason === "adaptive_includes_activity"
          ? "Din underhållsnivå räknas fram ur din egen vikt- och intagshistorik, " +
              "så träningen ligger redan i den siffran. Att lägga träningskalorier " +
              "ovanpå skulle räkna dem två gånger."
          : "Det finns ingen underhållsnivå att lägga träningen ovanpå ännu.",
      );
    }
  }

  const row = await updateProfileRow(userId, db, {
    ...(input.sex !== undefined ? { sex: input.sex } : {}),
    ...(input.birthDate !== undefined ? { birthDate: input.birthDate } : {}),
    ...(input.heightCm !== undefined
      ? { heightCm: toNumericOrNull(input.heightCm, 1)! }
      : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.activityFactor !== undefined
      ? { activityFactor: toNumericOrNull(input.activityFactor, 2)! }
      : {}),
    ...(input.addExerciseToTarget !== undefined
      ? { addExerciseToTarget: input.addExerciseToTarget }
      : {}),
    ...(input.newsMail !== undefined ? { newsMail: input.newsMail } : {}),
    ...(input.requestMail !== undefined ? { requestMail: input.requestMail } : {}),
    ...(input.remindWeigh !== undefined ? { remindWeigh: input.remindWeigh } : {}),
    ...(input.remindWeighMinute !== undefined
      ? { remindWeighMinute: input.remindWeighMinute }
      : {}),
    ...(input.remindDay !== undefined ? { remindDay: input.remindDay } : {}),
    ...(input.remindDayMinute !== undefined ? { remindDayMinute: input.remindDayMinute } : {}),
    ...(input.coachTone !== undefined ? { coachTone: input.coachTone } : {}),
    ...(input.remindWeighWeekend !== undefined
      ? { remindWeighWeekend: input.remindWeighWeekend }
      : {}),
    ...(input.remindWeighWeekendMinute !== undefined
      ? { remindWeighWeekendMinute: input.remindWeighWeekendMinute }
      : {}),
    ...(input.remindDayWeekend !== undefined
      ? { remindDayWeekend: input.remindDayWeekend }
      : {}),
    ...(input.remindDayWeekendMinute !== undefined
      ? { remindDayWeekendMinute: input.remindDayWeekendMinute }
      : {}),
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
    ...(input.soberAssumeUnloggedDry !== undefined
      ? { soberAssumeUnloggedDry: input.soberAssumeUnloggedDry }
      : {}),
    ...(input.lastDrinkOn !== undefined ? { lastDrinkOn: input.lastDrinkOn } : {}),
    /**
     * An explicit `null` clears the override and restores the derived value,
     * which is the entire way back (D52). An absent key still means "leave it
     * alone", so the profile form can send one field without resetting three.
     */
    ...(input.macroProteinG !== undefined ? { macroProteinG: input.macroProteinG } : {}),
    ...(input.macroCarbsG !== undefined ? { macroCarbsG: input.macroCarbsG } : {}),
    ...(input.macroFatG !== undefined ? { macroFatG: input.macroFatG } : {}),
    ...(input.macroFiberG !== undefined ? { macroFiberG: input.macroFiberG } : {}),
  });

  if (!row) throw notFound("This account has no profile row.");
  return getMe(userId, db);
}
