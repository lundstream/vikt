import { useState } from "react";
import { t } from "../i18n/index.js";
import { useInstall } from "../lib/install.js";

/**
 * The offer to install, in whichever form the platform allows (D116).
 *
 * Two shapes rather than one, because the platforms genuinely differ and
 * pretending otherwise produces a button that does nothing on half the phones
 * this app runs on. Chromium gets a button that opens the real prompt; iOS gets
 * the two gestures written out, because there is no API there and never has
 * been.
 *
 * **Nothing at all when the app is already installed**, which is the state most
 * readers of this control will eventually be in. Offering to install an app to
 * somebody standing inside it is the sort of thing that makes software feel
 * like it is not paying attention, and it is also the state where the advice is
 * actively wrong.
 *
 * No accent (§5, profile page 8): Inställningar has none, and this is neither a
 * failure nor an area. A button in Snö and a sentence in Sten.
 */
export function InstallApp({ variant = "section" }: { variant?: "section" | "inline" }) {
  const install = useInstall();
  const [outcome, setOutcome] = useState<"accepted" | "dismissed" | null>(null);

  if (install.kind === "installed" || install.kind === "unavailable") return null;

  /*
    Resolved to a boolean before it reaches any `className`. The class guard
    reads every string literal inside one and asks whether it resolves to a
    rule, so a `variant === "section"` comparison in that position looks to it
    like a class called `section`. Comparing here keeps the guard reading only
    real class names, which is what makes it able to catch a typo.
  */
  const inline = variant === "inline";

  return (
    <section
      data-testid="install-app"
      className={inline ? "mt-4" : "mt-10 border-t border-edge pt-6"}
    >
      {inline ? null : <h2 className="text-base text-ink">{t("install.title")}</h2>}
      <p className={inline ? "max-w-prose text-note text-muted" : "mt-2 max-w-prose text-note text-muted"}>
        {t("install.what")}
      </p>

      {install.kind === "promptable" ? (
        <>
          <button
            type="button"
            data-testid="install-button"
            className="btn mt-3 w-auto px-6"
            onClick={() => {
              void install.install().then(setOutcome);
            }}
          >
            {t("install.action")}
          </button>

          {/*
            Only the refusal is worth a line. An accepted install replaces the
            window with the installed app, so a message saying it worked is
            addressed to somebody who is no longer looking at it.
          */}
          {outcome === "dismissed" ? (
            <p role="status" className="mt-2 text-micro text-muted">
              {t("install.dismissed")}
            </p>
          ) : null}
        </>
      ) : (
        /*
          iOS. Two gestures, named the way the OS names them, because "add to
          home screen" is findable and "install" is not: there is no button
          anywhere on that platform with that word on it.
        */
        <ol
          data-testid="install-steps"
          className="mt-3 max-w-prose list-decimal space-y-1 pl-5 text-note text-muted"
        >
          <li>{t("install.iosShare")}</li>
          <li>{t("install.iosAdd")}</li>
        </ol>
      )}
    </section>
  );
}
