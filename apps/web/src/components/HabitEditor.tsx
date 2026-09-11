import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { HABIT_NAME_MAX, type Habit, type HabitIcon } from "shared";
import { t } from "../i18n/index.js";
import {
  useCreateHabit,
  useHabits,
  useRemoveHabit,
  useReorderHabits,
  useUpdateHabit,
} from "../lib/habits.js";
import { HABIT_ICON_KEYS, HabitIconGlyph } from "./habit-icons.js";
import { Sheet } from "./Sheet.js";
import { ConfirmSheet } from "./ConfirmSheet.js";

/**
 * Writing the checklist: add, rename, reorder, remove, remind (D137).
 *
 * In a sheet rather than on Dagen itself, because the list is written once and
 * ticked every day. Six controls per row on the screen somebody opens to tap
 * three things would be the tail wagging the dog; one link away is right.
 *
 * **Delete says what it will do before it does it.** Two buttons, not one with
 * a checkbox: "ta bort, behåll historiken" archives and the ticks stay in the
 * export, "ta bort allt" takes them with it. The difference is not recoverable,
 * so it is stated rather than defaulted.
 *
 * **Reorder is two buttons, not a drag.** A drag handle at 360 px next to a
 * scrolling page is a fight, and this list is five rows long. Up and down move
 * one place and write the whole order in one request.
 *
 * **The reminder is the same two-time shape as the other two** (D136), and it
 * is not drawn at all when the installation has no push keys: an unavailable
 * feature leaves no trace (D94).
 */

/** `420` becomes `07:00`, as in Inställningar. Minutes are what is stored. */
function toClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function fromClock(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

export function HabitEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const habits = useHabits();
  const create = useCreateHabit();
  const update = useUpdateHabit();
  const reorder = useReorderHabits();
  const remove = useRemoveHabit();

  const [name, setName] = useState("");
  const [icon, setIcon] = useState<HabitIcon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Habit | null>(null);

  /**
   * Whether this installation has push at all. Absent keys mean the reminder
   * controls are not drawn, the same rule Inställningar follows.
   */
  const pushKey = useQuery({
    queryKey: ["push", "key"],
    queryFn: async () => {
      const response = await fetch("/api/push/key", { credentials: "same-origin" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as { publicKey: string };
    },
    retry: false,
    staleTime: Infinity,
  });

  const rows = habits.data ?? [];

  const add = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;

    setError(null);
    create.mutate(
      { name: trimmed, icon },
      {
        onSuccess: () => {
          setName("");
          setIcon(null);
        },
        // The only refusal this form has is the list being full, and the server
        // says how full in its own words.
        onError: (failure) => setError(messageFor(failure)),
      },
    );
  };

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
        <form onSubmit={add} className="border-b border-edge pb-5">
          <label className="block text-micro text-muted" htmlFor="habit-name">
            {t("habit.name")}
          </label>
          <input
            id="habit-name"
            className="field mt-1 w-full"
            data-testid="habit-name"
            maxLength={HABIT_NAME_MAX}
            value={name}
            placeholder={t("habit.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />

          <p className="mt-3 text-micro text-muted">{t("habit.icon")}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {/* "Ingen" first, because no icon is the ordinary case. */}
            <button
              type="button"
              data-testid="habit-icon-none"
              aria-pressed={icon === null}
              className={`rounded-full px-3 py-2 text-micro ${
                icon === null ? "bg-logged text-paper" : "bg-field text-muted"
              }`}
              onClick={() => setIcon(null)}
            >
              {t("habit.iconNone")}
            </button>
            {HABIT_ICON_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`habit-icon-${key}`}
                aria-label={t(`habit.icon.${key}`)}
                aria-pressed={icon === key}
                className={`grid size-10 place-items-center rounded-full ${
                  icon === key ? "bg-logged text-paper" : "bg-field text-ink"
                }`}
                onClick={() => setIcon(key)}
              >
                <HabitIconGlyph icon={key} size={20} />
              </button>
            ))}
          </div>

          {error !== null ? (
            <p role="status" className="mt-3 text-note text-ink" data-testid="habit-error">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="btn mt-4 w-auto px-6"
            data-testid="habit-add"
            disabled={create.isPending || name.trim() === ""}
          >
            {t("habit.add")}
          </button>
        </form>

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
                    <label className="block text-micro text-muted">
                      {t("habit.name")}
                      <input
                        className="field mt-1 w-full"
                        data-testid={`habit-rename-${habit.id}`}
                        defaultValue={habit.name}
                        maxLength={HABIT_NAME_MAX}
                        onBlur={(event) => {
                          const value = event.target.value.trim();
                          if (value !== "" && value !== habit.name) {
                            update.mutate({ id: habit.id, patch: { name: value } });
                          } else {
                            event.target.value = habit.name;
                          }
                        }}
                      />
                    </label>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid={`habit-seticon-none-${habit.id}`}
                        aria-pressed={habit.icon === null}
                        className={`rounded-full px-3 py-2 text-micro ${
                          habit.icon === null ? "bg-logged text-paper" : "bg-field text-muted"
                        }`}
                        onClick={() => update.mutate({ id: habit.id, patch: { icon: null } })}
                      >
                        {t("habit.iconNone")}
                      </button>
                      {HABIT_ICON_KEYS.map((key) => (
                        <button
                          key={key}
                          type="button"
                          data-testid={`habit-seticon-${key}-${habit.id}`}
                          aria-label={t(`habit.icon.${key}`)}
                          aria-pressed={habit.icon === key}
                          className={`grid size-10 place-items-center rounded-full ${
                            habit.icon === key ? "bg-logged text-paper" : "bg-field text-ink"
                          }`}
                          onClick={() => update.mutate({ id: habit.id, patch: { icon: key } })}
                        >
                          <HabitIconGlyph icon={key} size={20} />
                        </button>
                      ))}
                    </div>

                    {/* The reminder, in the same two-time shape as the other two. */}
                    {pushKey.data != null ? (
                      <div className="mt-5">
                        <p className="text-note text-ink">{t("habit.reminder")}</p>
                        <p className="mt-1 max-w-prose text-micro text-muted">
                          {t("habit.reminderWhat")}
                        </p>
                        {/*
                          What the notification will say, in the habit's own
                          name, before anybody turns it on. The same preview
                          Inställningar shows for the other two.
                        */}
                        <p className="mt-1 max-w-prose text-micro text-muted">
                          {t("push.preview", {
                            text: t("push.notifyHabit", { name: habit.name }),
                          })}
                        </p>
                        <div className="mt-2 grid max-w-xs grid-cols-2 gap-4">
                          {(
                            [
                              {
                                part: "",
                                dayLabel: t("push.weekdays"),
                                timeLabel: t("push.timeWeekdays"),
                                on: habit.remind,
                                minute: habit.remindMinute,
                                onKey: "remind" as const,
                                minuteKey: "remindMinute" as const,
                              },
                              {
                                part: "-weekend",
                                dayLabel: t("push.weekend"),
                                timeLabel: t("push.timeWeekend"),
                                on: habit.remindWeekend,
                                minute: habit.remindWeekendMinute,
                                onKey: "remindWeekend" as const,
                                minuteKey: "remindWeekendMinute" as const,
                              },
                            ] as const
                          ).map((pair) => (
                            <div key={pair.part}>
                              <label className="flex items-center gap-2 text-note text-ink">
                                <input
                                  type="checkbox"
                                  className="check"
                                  data-testid={`habit-remind${pair.part}-${habit.id}`}
                                  checked={pair.on}
                                  disabled={update.isPending}
                                  onChange={(event) =>
                                    update.mutate({
                                      id: habit.id,
                                      patch: { [pair.onKey]: event.target.checked },
                                    })
                                  }
                                />
                                {pair.dayLabel}
                              </label>
                              <input
                                className="field num mt-1.5 w-full"
                                data-testid={`habit-remind${pair.part}-time-${habit.id}`}
                                aria-label={pair.timeLabel}
                                defaultValue={toClock(pair.minute)}
                                onBlur={(event) => {
                                  const parsed = fromClock(event.target.value);
                                  if (parsed !== null && parsed !== pair.minute) {
                                    update.mutate({
                                      id: habit.id,
                                      patch: { [pair.minuteKey]: parsed },
                                    });
                                  } else {
                                    event.target.value = toClock(pair.minute);
                                  }
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

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

function messageFor(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : t("habit.saveFailed");
}
