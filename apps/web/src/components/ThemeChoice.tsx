import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Theme } from "shared";
import { t, type TranslationKey } from "../i18n/index.js";
import { useMe } from "../lib/session.js";
import { applyTheme, cacheTheme, followSystem } from "../lib/theme.js";

/**
 * The theme, as a choice rather than as whatever the OS happens to say (D117).
 *
 * Three values, `system` first and default. The app followed the OS and only
 * the OS, which is right for most people and wrong for the two cases that
 * actually come up: a machine set light by a workplace policy, and a person who
 * wants this app dark at midday because it is a graph they read in the dark.
 *
 * ## Applied everywhere, not just here
 *
 * `ThemeApplier` is mounted in the shell rather than on this screen, because a
 * choice that only took effect while looking at Inställningar would be a
 * setting that appears not to work. This component is the control; that one is
 * the effect.
 *
 * ## No accent
 *
 * Profile page 8 gives Inställningar none, and §5 is explicit that a colour
 * names an area rather than a state. The chosen value is marked the way every
 * other chosen thing in this app is marked: Gran, because chosen is logged.
 */

const OPTIONS: { value: Theme; label: TranslationKey }[] = [
  { value: "system", label: "theme.system" },
  { value: "dark", label: "theme.dark" },
  { value: "light", label: "theme.light" },
];

export function ThemeChoice() {
  const me = useMe();
  const queryClient = useQueryClient();
  const current = me.data?.profile.theme ?? "system";

  const save = useMutation({
    mutationFn: async (theme: Theme) => {
      const response = await fetch("/api/me/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme }),
      });
      if (!response.ok) throw new Error(String(response.status));
      return theme;
    },
    /**
     * Applied before the request, not after.
     *
     * A theme that waits for a round trip feels broken on a slow connection,
     * and the write is one enum on one row: if it fails, the next load reverts
     * it, which is a smaller cost than half a second of a button that seems
     * dead. The cache is written here too, so a cold start paints this choice.
     */
    onMutate: (theme) => {
      applyTheme(theme);
      cacheTheme(theme);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  return (
    <section className="mt-10 border-t border-edge pt-6" data-testid="theme-choice">
      <h2 className="text-base text-ink">{t("theme.title")}</h2>
      <p className="mt-2 max-w-prose text-note text-muted">{t("theme.what")}</p>

      {/*
        Three buttons rather than a select. The whole set is three short words,
        so showing them costs one line and reading them costs no interaction,
        and the same treatment as the scale buttons on Dagen means "chosen"
        looks the same across the app (profile page 6).
      */}
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t("theme.title")}>
        {OPTIONS.map((option) => {
          const chosen = current === option.value;
          return (
            <button
              key={option.value}
              type="button"
              data-testid={`theme-${option.value}`}
              aria-pressed={chosen}
              disabled={save.isPending}
              onClick={() => save.mutate(option.value)}
              className={[
                "min-h-11 rounded-lg border px-4 py-2 text-note transition-colors",
                chosen
                  ? "border-logged bg-logged/15 text-ink"
                  : "border-edge text-muted hover:text-ink",
              ].join(" ")}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Keeps the document in step with the account's choice (D117).
 *
 * Mounted once, in the shell. Two jobs: apply the choice when `/api/me` arrives
 * or changes, and subscribe to the OS **only** while the choice is `system`.
 * The old listener was unconditional, which was correct when following the OS
 * was the only behaviour and is wrong now: someone who picked dark should not
 * watch this app turn light at sunset with the rest of their desktop.
 */
export function ThemeApplier() {
  const theme = useMe().data?.profile.theme ?? "system";

  useEffect(() => {
    applyTheme(theme);
    cacheTheme(theme);
    return followSystem(theme);
  }, [theme]);

  return null;
}
