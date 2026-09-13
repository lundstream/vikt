import { useState } from "react";
import type { Habit } from "shared";
import { t } from "../i18n/index.js";
import { useHabits, useRemoveHabit, useReorderHabits } from "../lib/habits.js";
import { HabitForm } from "./HabitForm.js";
import { HabitIconGlyph } from "./habit-icons.js";
import { Sheet } from "./Sheet.js";
import { ConfirmSheet } from "./ConfirmSheet.js";

/**
 * Writing the checklist: add, rename, reorder, remind, remove (D137, D142).
 *
 * In a sheet rather than on Dagen itself, because the list is written once and
 * ticked every day. Six controls per row on the screen somebody opens to tap
 * three things would be the tail wagging the dog; one link away is right.
 *
 * **One form for a new habit and an existing one** (`HabitForm`), which is the
 * amendment D142 made. The create half used to offer a name and an icon while
 * the edit half also offered a reminder, so the reminder was invisible until
 * somebody reopened a habit they had already made: the owner found it by
 * accident. Two sets of controls for one entity is the shape that permits that,
 * and there is now one.
 *
 * **Delete says what it will do before it does it.** Two buttons, not one with
 * a checkbox: "ta bort, behåll historiken" archives and the ticks stay in the
 * export, "ta bort allt" takes them with it. The difference is not recoverable,
 * so it is stated rather than defaulted.
 *
 * **Reorder is two buttons, not a drag.** A drag handle at 360 px inside a
 * scrolling page is a fight, and this list is five rows long.
 */
export function HabitEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const habits = useHabits();
  const reorder = useReorderHabits();
  const remove = useRemoveHabit();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Habit | null>(null);

  const rows = habits.data ?? [];

  const move = (index: number, by: -1 | 1) => {
    const next = [...rows];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    reorder.mutate(next.map((habit) => habit.id));
  };

  return (
    <>
      <Sheet open={open} onClose={onClose} title={t("habit.editTitle")} testId="habit-editor">
        {/* The new one. Same fields, same reminder, same defaults. */}
        <div className="border-b border-edge pb-5">
          <HabitForm habit={null} />
        </div>

        {rows.length === 0 ? null : (
          <ul className="divide-y divide-edge">
            {rows.map((habit, index) => (
              <li key={habit.id} className="py-4">
                <div className="flex items-center gap-3">
                  <span className="text-muted">
                    <HabitIconGlyph icon={habit.icon} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body text-ink">{habit.name}</span>

                  <button
                    type="button"
                    className="btn-link shrink-0 text-micro"
                    data-testid={`habit-up-${habit.id}`}
                    aria-label={t("habit.moveUp")}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => move(index, -1)}
                  >
                    {"↑"}
                  </button>
                  <button
                    type="button"
                    className="btn-link shrink-0 text-micro"
                    data-testid={`habit-down-${habit.id}`}
                    aria-label={t("habit.moveDown")}
                    disabled={index === rows.length - 1 || reorder.isPending}
                    onClick={() => move(index, 1)}
                  >
                    {"↓"}
                  </button>
                  <button
                    type="button"
                    className="btn-link shrink-0 text-micro"
                    data-testid={`habit-open-${habit.id}`}
                    aria-expanded={expanded === habit.id}
                    onClick={() => setExpanded(expanded === habit.id ? null : habit.id)}
                  >
                    {t("habit.change")}
                  </button>
                </div>

                {expanded === habit.id ? (
                  <div className="mt-3 pl-1" data-testid={`habit-panel-${habit.id}`}>
                    {/*
                      The same component as above, handed an existing habit
                      rather than a copy of its fields. A copy is what let the
                      two halves drift in the first place.
                    */}
                    <HabitForm habit={habit} onSaved={() => setExpanded(null)} />

                    <button
                      type="button"
                      className="btn-link mt-5 text-micro"
                      data-testid={`habit-remove-${habit.id}`}
                      onClick={() => setConfirming(habit)}
                    >
                      {t("habit.remove")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      {/*
        Two outcomes, both named, neither defaulted. Archiving is the gentler
        one and comes first; the irreversible one says that the ticks go too.
      */}
      <ConfirmSheet
        open={confirming !== null}
        testId="habit-remove-confirm"
        title={t("habit.removeTitle", { name: confirming?.name ?? "" })}
        body={
          <>
            <p>{t("habit.removeKeepBody")}</p>
            <p className="mt-2">{t("habit.removeAllBody")}</p>
            <button
              type="button"
              className="btn-impact mt-4 w-auto px-6"
              data-testid="habit-remove-all"
              disabled={remove.isPending}
              onClick={() => {
                if (confirming === null) return;
                remove.mutate(
                  { id: confirming.id, history: "remove" },
                  { onSuccess: () => setConfirming(null) },
                );
              }}
            >
              {t("habit.removeAll")}
            </button>
          </>
        }
        confirmLabel={t("habit.removeKeep")}
        busy={remove.isPending}
        onConfirm={() => {
          if (confirming === null) return;
          remove.mutate(
            { id: confirming.id, history: "keep" },
            { onSuccess: () => setConfirming(null) },
          );
        }}
        onClose={() => setConfirming(null)}
      />
    </>
  );
}
