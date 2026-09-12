import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { HABIT_NAME_MAX, isHabitIcon, type Habit, type HabitIcon } from "shared";
import { t } from "../i18n/index.js";
import { useCreateHabit, useUpdateHabit } from "../lib/habits.js";
import { HABIT_ICON_KEYS, HabitIconGlyph } from "./habit-icons.js";

/**
 * One habit, new or existing (D142).
 *
 * **The same form for both**, which is the whole point of the file. Creating a
 * habit and editing one used to be two different sets of controls in one sheet,
 * and only the edit half offered the reminder. The result was an option nobody
 * could find: you had to create a habit, reopen it, and only then learn that a
 * habit can remind you at all. That is the same defect class as a shared
 * function with call sites that walk past it, and the fix is the same one:
 * there is only one place, so there is nothing to walk past.
 *
 * It saves on submit rather than on each blur. With a reminder in the form, per
 * field saving would have written four times while somebody set one time, and a
 * half-applied reminder is a notification at the wrong hour.
 *
 * The reminder is not drawn at all without VAPID keys, exactly as in
 * Inställningar: an unavailable feature leaves no trace (D94).
 */

/** `420` becomes `07:00`. Minutes past local midnight are what is stored. */
function toClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function fromClock(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

/** 08:00, which is a guess about vitamins rather than a claim about anything. */
const DEFAULT_MINUTE = 480;

export function HabitForm({
  habit,
  onSaved,
}: {
  /** Null when this is a new habit. Everything else is identical. */
  habit: Habit | null;
  onSaved?: () => void;
}) {
  const create = useCreateHabit();
  const update = useUpdateHabit();

  /** The ids differ per habit so two open forms cannot collide. */
  const suffix = habit === null ? "" : `-${habit.id}`;

  const [name, setName] = useState(habit?.name ?? "");
  /**
   * Typed to the closed set. A habit read back from the API carries `icon` as a
   * plain string, and narrowing it here is what keeps the form from sending an
   * icon the server would refuse.
   */
  const [icon, setIcon] = useState<HabitIcon | null>(
    habit?.icon != null && isHabitIcon(habit.icon) ? habit.icon : null,
  );
  const [remind, setRemind] = useState(habit?.remind ?? false);
  const [remindMinute, setRemindMinute] = useState(habit?.remindMinute ?? DEFAULT_MINUTE);
  const [remindWeekend, setRemindWeekend] = useState(habit?.remindWeekend ?? false);
  const [remindWeekendMinute, setRemindWeekendMinute] = useState(
    habit?.remindWeekendMinute ?? DEFAULT_MINUTE,
  );
  const [error, setError] = useState<string | null>(null);

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

  const saving = create.isPending || update.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || saving) return;

    setError(null);
    const fields = { name: trimmed, icon, remind, remindMinute, remindWeekend, remindWeekendMinute };

    if (habit === null) {
      create.mutate(fields, {
        onSuccess: () => {
          setName("");
          setIcon(null);
          setRemind(false);
          setRemindMinute(DEFAULT_MINUTE);
          setRemindWeekend(false);
          setRemindWeekendMinute(DEFAULT_MINUTE);
          onSaved?.();
        },
        // The only refusal this form has is the list being full, and the server
        // says how full in its own words.
        onError: (failure) => setError(messageFor(failure)),
      });
      return;
    }

    update.mutate(
      { id: habit.id, patch: fields },
      { onSuccess: () => onSaved?.(), onError: (failure) => setError(messageFor(failure)) },
    );
  };

  const times = [
    {
      part: "",
      dayLabel: t("push.weekdays"),
      timeLabel: t("push.timeWeekdays"),
      on: remind,
      setOn: setRemind,
      minute: remindMinute,
      setMinute: setRemindMinute,
    },
    {
      part: "-weekend",
      dayLabel: t("push.weekend"),
      timeLabel: t("push.timeWeekend"),
      on: remindWeekend,
      setOn: setRemindWeekend,
      minute: remindWeekendMinute,
      setMinute: setRemindWeekendMinute,
    },
  ] as const;

  return (
    <form onSubmit={submit} data-testid={`habit-form${suffix}`}>
      <label className="block text-micro text-muted" htmlFor={`habit-name${suffix}`}>
        {t("habit.name")}
      </label>
      <input
        id={`habit-name${suffix}`}
        className="field mt-1 w-full"
        data-testid={`habit-name${suffix}`}
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
          data-testid={`habit-icon-none${suffix}`}
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
            data-testid={`habit-icon-${key}${suffix}`}
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

      {/*
        The reminder, offered here whether the habit exists yet or not (D142),
        in the two-time shape D136 settled. Off by default: a notification
        nobody asked for is the fastest way to have notifications turned off.
      */}
      {pushKey.data != null ? (
        <div className="mt-5">
          <p className="text-note text-ink">{t("habit.reminder")}</p>
          <p className="mt-1 max-w-prose text-micro text-muted">{t("habit.reminderWhat")}</p>
          <p className="mt-1 max-w-prose text-micro text-muted">
            {t("push.preview", {
              text: t("push.notifyHabit", { name: name.trim() === "" ? t("habit.thisHabit") : name.trim() }),
            })}
          </p>

          <div className="mt-2 grid max-w-xs grid-cols-2 gap-4">
            {times.map((pair) => (
              <div key={pair.part}>
                <label className="flex items-center gap-2 text-note text-ink">
                  <input
                    type="checkbox"
                    className="check"
                    data-testid={`habit-remind${pair.part}${suffix}`}
                    checked={pair.on}
                    disabled={saving}
                    onChange={(event) => pair.setOn(event.target.checked)}
                  />
                  {pair.dayLabel}
                </label>
                <input
                  className="field num mt-1.5 w-full"
                  data-testid={`habit-remind${pair.part}-time${suffix}`}
                  aria-label={pair.timeLabel}
                  defaultValue={toClock(pair.minute)}
                  onBlur={(event) => {
                    const parsed = fromClock(event.target.value);
                    if (parsed === null) {
                      event.target.value = toClock(pair.minute);
                      return;
                    }
                    pair.setMinute(parsed);
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <p role="status" className="mt-3 text-note text-ink" data-testid={`habit-error${suffix}`}>
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="btn mt-4 w-auto px-6"
        data-testid={habit === null ? "habit-add" : `habit-save-${habit.id}`}
        disabled={saving || name.trim() === ""}
      >
        {habit === null ? t("habit.add") : t("habit.save")}
      </button>
    </form>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : t("habit.saveFailed");
}
