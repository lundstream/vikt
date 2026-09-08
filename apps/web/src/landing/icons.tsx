/**
 * The landing page's icons (D99).
 *
 * Drawn here rather than installed. The app ships no icon library and seven
 * glyphs do not justify one, and an inlined path cannot quietly change weight
 * or metaphor when a package is updated.
 *
 * All of them are line icons on a 24 unit grid at stroke width 1.75, with round
 * caps and joins, so a row of them reads as one set. The single exception is
 * `GitHubMark`, and it is deliberate: GitHub's octocat is a brand mark, it is
 * recognised as a shape rather than read as a picture, and an outlined redraw
 * of it is both less recognisable and, strictly, not their mark. A link whose
 * whole job is to be spotted keeps the logo it is known by.
 *
 * Icons here never carry meaning alone (§5). Every one sits beside its own
 * label, and the three on the figure cards take their colour from the profile's
 * semantic map rather than from what looks good: Gran for logging, Honung for
 * money, Is for secondary data.
 */

type IconProps = { className?: string };

/** The shared geometry. Everything below differs only in its paths. */
function Line({ className = "size-4", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} shrink-0`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * GitHub's own mark, filled, at the size of the line icons beside it.
 *
 * See the note at the top of the file: this is the one glyph that is a brand
 * rather than a drawing, and redrawing it would make it both less recognisable
 * and not theirs.
 */
export function GitHubMark({ className = "size-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={`${className} shrink-0`} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** A tap. The figure beside it counts taps, so the glyph is the gesture. */
export function TapIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12 11V9.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M15 11v-.5a1.5 1.5 0 0 1 3 0V15a5 5 0 0 1-5 5h-1.6a4 4 0 0 1-3.1-1.48L6 15.5a1.5 1.5 0 0 1 2.3-1.9L9 14.4V11" />
    </Line>
  );
}

/** A coin. Honung is the pot and the rewards, and this figure is the price. */
export function CoinIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M14.5 9.25a3 3 0 0 0-2.5-1.25c-1.5 0-2.5.9-2.5 2s1 1.75 2.5 2 2.5.9 2.5 2-1 2-2.5 2a3 3 0 0 1-2.5-1.25" />
      <path d="M12 6.5v11" />
    </Line>
  );
}

/** A server. Is is secondary data, and this figure is about where it sits. */
export function ServerIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <rect x="3.25" y="4.25" width="17.5" height="6" rx="1.75" />
      <rect x="3.25" y="13.75" width="17.5" height="6" rx="1.75" />
      <path d="M6.75 7.25h.01M6.75 16.75h.01" />
      <path d="M11 7.25h5M11 16.75h5" />
    </Line>
  );
}

/** A licence: a document with a seal. */
export function LicenceIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M13.5 3.25H7A1.75 1.75 0 0 0 5.25 5v14A1.75 1.75 0 0 0 7 20.75h10A1.75 1.75 0 0 0 18.75 19v-8.5Z" />
      <path d="M13.25 3.5v5.25h5.25" />
      <path d="M8.75 13.5h6.5M8.75 16.75h4" />
    </Line>
  );
}

/** Privacy: a closed padlock. Not a shield, which reads as protection-from. */
export function LockIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <rect x="4.75" y="10.25" width="14.5" height="9.5" rx="2" />
      <path d="M8.25 10.25V7.5a3.75 3.75 0 0 1 7.5 0v2.75" />
      <path d="M12 14v2.25" />
    </Line>
  );
}

/**
 * The beer mug, redrawn as a line icon.
 *
 * D97 took formulaspun's filled glyph path for path, so the same link from the
 * same person would be recognised in both places. It stays the same glyph and
 * the same idea, now at the weight of the icons beside it: a filled mug in a
 * row of four line icons was the one thing in the footer that looked pasted in.
 */
export function BeerIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M5.25 5.25h9.5v13.5a2 2 0 0 1-2 2h-5.5a2 2 0 0 1-2-2Z" />
      <path d="M14.75 8.25h2.5a2 2 0 0 1 2 2v3.5a2 2 0 0 1-2 2h-2.5" />
      <path d="M8.25 9v8M11.75 9v8" />
    </Line>
  );
}

/** Terms: a document with a signature line. Not a gavel, which reads as a court. */
export function TermsIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M13.5 3.25H7A1.75 1.75 0 0 0 5.25 5v14A1.75 1.75 0 0 0 7 20.75h10A1.75 1.75 0 0 0 18.75 19V8.5Z" />
      <path d="M13.25 3.5v5.25h5.25" />
      <path d="M8.75 16.5c1.2-2.5 2-3.75 2.5-3.75s.6 2.5 1.2 2.5 1-1.25 1.8-1.25" />
    </Line>
  );
}

/** Food. The same fork and knife the bottom bar uses for Mat. */
export function ForkIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M6 3v8a2 2 0 0 0 4 0V3M8 11v10" />
      <path d="M17 3c-1.5 2-2 4-2 6a2 2 0 0 0 2 2v10" />
    </Line>
  );
}

/** The day. The same calendar the bottom bar uses for Dagen. */
export function CalendarIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M4 11h16" />
    </Line>
  );
}

/** Milestones. The same trophy the bottom bar uses for Framsteg. */
export function TrophyIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M8 21h8M12 17v4" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
    </Line>
  );
}
