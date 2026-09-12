import { useMutation, useQueryClient } from "@tanstack/react-query";
import { COACH_TONES, type CoachTone as Tone } from "shared";
import { t, type TranslationKey } from "../i18n/index.js";
import { api } from "../lib/api.js";
import { useMe } from "../lib/session.js";

/**
 * Which voice the coach speaks in (D140).
 *
 * **The labels are lowercase.** They are adjectives naming a setting's value,
 * not names: "torr" is how the coach sounds, the way "mörkt" is how the screen
 * looks. §5 requires sentence case rather than lowercase, so this is a choice
 * inside that rule and not an exception to it, and the news rows in STATE.md
 * quote the screen rather than a capitalised version of it.
 *
 * Three, chosen here and applied to both the chat and the weekly review,
 * because they are one voice from one prompt and a person who picks a tone
 * picks it for both.
 *
 * **The set is closed**, and the closure is a decision rather than an
 * implementation detail: a strict, roasting or guilt-based tone is ruled out by
 * §3's no-failure-state rule and by the Phase 8 entry's "never nagging, never
 * guilt", not by taste. Adding a fourth means amending both documents.
 *
 * Stored on the profile rather than in the browser, like the theme (D117): the
 * review is written by a scheduler that has no browser to ask, and a tone
 * chosen on the phone is meant on the laptop.
 */

const TONES: { key: Tone; label: TranslationKey; what: TranslationKey }[] = [
  { key: "torr", label: "coach.toneTorr", what: "coach.toneTorrWhat" },
  { key: "peppig", label: "coach.tonePeppig", what: "coach.tonePeppigWhat" },
  { key: "saklig", label: "coach.toneSaklig", what: "coach.toneSakligWhat" },
];

export function CoachTone() {
  const me = useMe();
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (coachTone: Tone) => api.updateProfile({ coachTone }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  const current = me.data?.profile.coachTone ?? "torr";
  const chosen = TONES.find((tone) => tone.key === current) ?? TONES[0]!;

  return (
    <section className="mt-6" data-testid="coach-tone">
      <h2 className="text-base text-ink">{t("coach.toneTitle")}</h2>

      <div className="mt-2 flex flex-wrap gap-2">
        {COACH_TONES.map((key) => {
          const tone = TONES.find((entry) => entry.key === key)!;
          const selected = key === current;

          return (
            <button
              key={key}
              type="button"
              data-testid={`coach-tone-${key}`}
              aria-pressed={selected}
              disabled={save.isPending}
              className={`rounded-md border px-4 py-2 text-note ${
                selected ? "border-logged bg-logged/15 text-ink" : "border-edge text-muted"
              }`}
              onClick={() => save.mutate(key)}
            >
              {t(tone.label)}
            </button>
          );
        })}
      </div>

      {/*
        What the chosen one sounds like, in a sentence, under the row. Three
        descriptions stacked would be a menu to read; one is an answer to "what
        did I just pick".
      */}
      <p className="mt-2 max-w-prose text-micro text-muted" data-testid="coach-tone-what">
        {t(chosen.what)} {t("coach.toneBoth")}
      </p>
    </section>
  );
}
