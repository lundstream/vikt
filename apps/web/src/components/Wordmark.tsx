import type React from "react";
import { appName } from "../lib/app-name.js";

/**
 * The logo — `docs/Vikt-grafisk-profil.pdf`, page 7 (D86).
 *
 * One component, and that is deliberate rather than tidy. Lingon is allowed in
 * exactly two places in this app: the trend line, and the wordmark. Spread
 * across three screens that rule is a convention someone has to remember; as a
 * single component it is a fact a test can check, and `colour-meaning.test.ts`
 * checks it.
 *
 * **The wordmark** is the word in Archivo, bold, slightly extended, in Lingon.
 * Never another colour, and Lingon never on any other text.
 *
 * **The mark** is the trend line with its endpoint and two raw readings behind
 * it: the same picture as the hero on Översikt, at icon size. It is the app, so
 * it is never a button — putting it on "väg dig" would make the identity into a
 * control.
 *
 * Where each goes: the auth screens get both, centred. The app icon is the mark
 * alone on Skymning. The header gets the wordmark alone, because the mark there
 * would compete with the graph directly beneath it.
 *
 * No shadow, no tilt, no outline, no animation. The line moves in the graph.
 */

/**
 * The word, at whatever size the caller sets.
 *
 * `appName()` rather than a literal, because the name is an environment
 * variable — but the *wordmark* is set: renaming the app changes the word and
 * changes nothing else about how it is drawn.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`wordmark text-trend ${className}`}>{appName()}</span>;
}

/**
 * The mark: the curve, one end dot, and nothing else (D91).
 *
 * Profile v1.1 draws it as an **S**: nearly level leaving the start, steep
 * through the middle, level again into the end dot. That is the shape of a real
 * trend rather than a diagonal — a plateau, a drop, a plateau — and it is the
 * same picture as the hero on Översikt, at icon size.
 *
 * v1.1 also removed the two raw readings that v1 put behind the line, which is
 * what D91 had already done for the reason v1.1 gives: "råpunkter blir brus i
 * ikonstorlek". At 24 px they were two grey pixels that read as dirt on the
 * glass.
 *
 * The endpoint is the part that has to survive, so it is drawn large relative
 * to the stroke rather than proportionally. At 24 px it is about three device
 * pixels across, which is the smallest a dot can be and still be a dot.
 *
 * Drawn rather than imported so it inherits the theme's tokens. The files in
 * `public/` are the same geometry with the palette baked in, because an icon
 * the OS renders has no stylesheet to ask.
 */
export function Mark({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role="img"
      aria-hidden="true"
      className={className}
    >
      <rect width="48" height="48" rx="10" className="fill-card" />
      <path
        d="M10 15 C 22 15, 26 33, 38 33"
        fill="none"
        className="stroke-trend"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <circle cx="38" cy="33" r="5" className="fill-trend" />
    </svg>
  );
}

/** Mark above wordmark, centred. The auth screens, and only those. */
export function Logo({
  className = "",
  ...rest
}: { className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`flex flex-col items-center gap-3 ${className}`} {...rest}>
      <Mark size={48} />
      <Wordmark className="text-3xl" />
    </span>
  );
}

/**
 * The header lockup: mark and wordmark side by side at 20 px (D91).
 *
 * This overrides page 7's rule that the mark never appears in the header. That
 * rule's stated objection was that the mark "competes with the graph beneath
 * it" — an objection about **size**, not about presence. At 20 px, beside the
 * word and above a chart that occupies a third of the screen, it competes with
 * nothing; it reads as an identity, which is what a header is for.
 */
export function HeaderLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Mark size={20} />
      <Wordmark className="text-[20px] leading-none" />
    </span>
  );
}
