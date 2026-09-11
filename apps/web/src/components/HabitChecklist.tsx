import { useState } from "react";
import type { HabitDay } from "shared";
import { t } from "../i18n/index.js";
import { useCheckHabit, useCreateHabit } from "../lib/habits.js";
import { useMe } from "../lib/session.js";
import { HabitIconGlyph } from "./habit-icons.js";
import { HabitEditor } from "./HabitEditor.js";

/**
 * The habit checklist, on Dagen (D137).
 *
 * **One tap to tick, one to untick.** The whole row is the control, not a
 * checkbox beside a label: a 44 px target somebody hits without looking, which
 * is the same discipline the ratings on this screen are built to. Nothing to
 * save afterwards. A tick is its own write, queued like every other log row, so
 * it survives a tunnel.
 *
 * **Unticking writes a row rather than deleting one.** A day answered with no
 * tick is a different fact from a day nobody answered, and the streak needs the
 * difference: the first is a miss the grace day covers, the second is unknown
 * and stops the count (D35's distinction, D137's streak).
 *
 * **The streak is quiet.** "4 dagar i rad" under the name when there is a
 * chain, nothing when there is not. No flame, no badge, no colour that only
 * appears on a bad day: §3 has no failure state, and a checklist is exactly
 * where one would get invented.
 *
 * **Nothing is seeded.** An empty list says what it is for in one line and
 * offers three common ones to add with a tap. They are suggestions: a list
 * somebody did not write is a list they have to prune before it means anything.
 */

/** The three an empty list offers. Copy in the register, like all copy. */
const EXAMPLES = [
  { key: "habit.exampleWater", icon: "droppe" },
  { key: "habit.exampleVitamins", icon: "tablett" },
  { key: "habit.exampleStretch", icon: "stretch" },
] as const;

export function HabitChecklist({
  habits,
  localDate,
}: {
  habits: readonly HabitDay[];
  /** The day being shown, which is not always today (D62). */
  localDate: string;
}) {
  /**
   * The account's timezone, for the queue's day stamp (D39). Read here rather
   * than threaded down from Dagen: it is the tick's property, not the screen's.
   */
  const me = useMe();
  const check = useCheckHabit(me.data?.profile.timezone ?? "Europe/Stockholm");
  const create = useCreateHabit();
  const [editing, setEditing] = useState(false);

  const toggle = (habit: HabitDay) => {
    check.mutate({ habitId: habit.id, localDate, checked: !habit.checked });
  };

  return (
    <section className="mt-10" data-testid="habits">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base text-ink">{t("habit.title")}</h2>
        <button
          type="button"
          className="btn-link text-micro"
          data-testid="habits-edit"
          onClick={() => setEditing(true)}
        >
          {habits.length === 0 ? t("habit.add") : t("habit.edit")}
        </button>
      </div>

      {habits.length === 0 ? (
        <div className="mt-2">
          <p className="max-w-prose text-note text-muted">{t("habit.empty")}</p>
          <p className="mt-3 text-micro text-muted">{t("habit.examplesLead")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example.key}
                type="button"
                className="flex items-center gap-2 rounded-full bg-field px-3 py-2 text-note text-ink"
                data-testid={`habit-example-${example.icon}`}
                disabled={create.isPending}
                onClick={() =>
                  create.mutate({ name: t(example.key), icon: example.icon })
                }
              >
                <span className="text-muted">
                  <HabitIconGlyph icon={example.icon} size={18} />
                </span>
                {t(example.key)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-edge border-y border-edge">
            {habits.map((habit) => (
              <li key={habit.id}>
                <button
                  type="button"
                  /**
                   * `aria-pressed` rather than a checkbox role: this is one
                   * control that is on or off, and a screen reader should say
                   * the habit's name and whether it is done, in that order.
                   */
                  aria-pressed={habit.checked}
                  data-testid={`habit-${habit.id}`}
                  className="flex w-full items-center gap-3 py-3 text-left"
                  onClick={() => toggle(habit)}
                >
                  {/*
                    Dis at rest, Gran when it is done: "logged, chosen" is what
                    Gran means in the profile, and a ticked habit is chosen.
                    The mark is a mark, not colour alone.
                  */}
                  <span
                    aria-hidden="true"
                    className={`grid size-7 shrink-0 place-items-center rounded-full ${
                      habit.checked ? "bg-logged text-paper" : "bg-field text-muted"
                    }`}
                  >
                    {habit.checked ? (
                      <svg viewBox="0 0 24 24" width="16" height="16">
                        <path
                          d="M5 12.5 10 17.5 19 7"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.25"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : null}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-muted">
                        <HabitIconGlyph icon={habit.icon} />
                      </span>
                      <span className="truncate text-body text-ink">{habit.name}</span>
                    </span>
                    {habit.streak.days > 0 ? (
                      <span className="num mt-0.5 block text-micro text-muted">
                        {habit.streak.days === 1
                          ? t("habit.streakOne")
                          : t("habit.streakDays", { days: String(habit.streak.days) })}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {/*
            Which rule produced those numbers, said once under the list rather
            than on every row. The sober counter does the same thing for the
            same reason: a bare number whose meaning depends on invisible state
            is a number nobody can check.
          */}
          <p className="mt-2 max-w-prose text-micro text-muted">{t("habit.rule")}</p>
        </>
      )}

      <HabitEditor open={editing} onClose={() => setEditing(false)} />
    </section>
  );
}
