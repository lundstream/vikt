import { useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../i18n/index.js";
import { InstallApp } from "./InstallApp.js";

/**
 * The whole of onboarding (D105).
 *
 * Three links, once, dismissible. Not a wizard, not a checklist that follows
 * you around, and nothing that has to be finished before the app will work.
 *
 * ## Why onboarding is the empty state
 *
 * **Nothing here is needed to log.** Weighing yourself needs an account and a
 * scale. Logging food needs an account. Height, a birth date and a goal are
 * inputs to *calculations* — BMI, waist-to-height, the formula maintenance
 * figure, a projection — and every one of those already says exactly what it is
 * missing, because D20 made "missing" a first-class answer rather than a zero.
 *
 * So a registration form that demanded height was asking somebody to find a
 * tape measure before they could see the app at all, to make a number they had
 * not asked for computable. The screens ask for what they need, where they need
 * it, when the person is looking at the thing it would improve.
 *
 * This card exists because the empty states are individually quiet by design,
 * and on a completely empty account "quiet everywhere" gives no first step. It
 * names three, and then goes away.
 *
 * ## Why it is dismissed locally
 *
 * `localStorage`, not a column. Dismissing it is a per-device preference about
 * a piece of guidance, it authorises nothing, and it is the kind of thing the
 * cached-identity note in `session.ts` is about: a fact that does not go out of
 * date between one morning and the next. A migration and a write path for
 * "I have seen the welcome card" is more machinery than the thing is worth.
 */

const DISMISSED_KEY = "vikt.welcome.dismissed";

function alreadyDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // A private window. Showing the card again is a much smaller cost than
    // failing to render the dashboard.
    return false;
  }
}

export function WelcomeCard({
  hasWeight,
  hasHeight,
  hasPlan,
}: {
  hasWeight: boolean;
  hasHeight: boolean;
  hasPlan: boolean;
}) {
  const [dismissed, setDismissed] = useState(alreadyDismissed);

  /**
   * Gone once there is nothing left to suggest, without anybody dismissing it.
   * A card that congratulates you for finishing it is a card that has outstayed
   * its welcome by exactly one screen.
   */
  const steps = [
    { done: hasWeight, to: "/", label: "welcome.weigh", testId: "welcome-weigh" },
    { done: hasHeight, to: "/profile", label: "welcome.height", testId: "welcome-height" },
    { done: hasPlan, to: "/framsteg", label: "welcome.goal", testId: "welcome-goal" },
  ] as const;

  const remaining = steps.filter((step) => !step.done);
  if (dismissed || remaining.length === 0) return null;

  return (
    <section className="panel mb-6" data-testid="welcome-card">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-title text-ink">{t("welcome.title")}</h2>
        <button
          type="button"
          data-testid="welcome-dismiss"
          className="min-h-11 shrink-0 text-note text-muted underline underline-offset-4"
          onClick={() => {
            try {
              localStorage.setItem(DISMISSED_KEY, "1");
            } catch {
              // Nothing to do. It comes back next time, which is survivable.
            }
            setDismissed(true);
          }}
        >
          {t("welcome.dismiss")}
        </button>
      </div>

      <p className="mt-2 max-w-prose text-note text-muted">{t("welcome.what")}</p>

      <ul className="mt-4 divide-y divide-edge border-y border-edge">
        {remaining.map((step) => (
          <li key={step.to}>
            <Link
              to={step.to}
              data-testid={step.testId}
              className="block py-3 text-body text-ink"
            >
              {t(step.label)}
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-micro text-muted">{t("welcome.optional")}</p>

      {/*
        And the one thing that is not a step (D116).
        
        Not in the list above, because that list is "what makes the numbers
        real" and this is not one of those: the app works identically in a tab.
        It is here because this is the one moment somebody is looking at the app
        for the first time and deciding where it lives, and because the card
        disappears afterwards, which is the right lifetime for an offer like
        this. It renders nothing at all if they have already installed it.
      */}
      <InstallApp variant="inline" />
    </section>
  );
}
