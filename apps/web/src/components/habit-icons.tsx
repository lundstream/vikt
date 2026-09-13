import type { ReactNode } from "react";
import { HABIT_ICONS, type HabitIcon } from "shared";

/**
 * The icons a habit may carry (D137).
 *
 * Drawn to the profile's line set, the same one the quick actions use: no fill,
 * `currentColor`, 1.75 stroke, round caps and joins, on a 24 unit grid. They
 * are read at 20 px in a list row, so each one is carried by its silhouette
 * rather than by detail, and held to the same test as the food icons: cover the
 * label and they still have to be tellable apart.
 *
 * The set is closed, and the closed set lives in `shared` because the server
 * validates against it. An icon is never the content: the habit's name is, and
 * a habit with no icon is a perfectly ordinary habit.
 */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** A falling drop. Water, the commonest thing on a list like this. */
const droppe = <path d="M12 3.5c3.2 4 5 6.4 5 8.8a5 5 0 0 1-10 0c0-2.4 1.8-4.8 5-8.8Z" {...stroke} />;

/** A capsule on the diagonal, with the seam across it. */
const tablett = (
  <>
    <rect x="3.6" y="9" width="16.8" height="6" rx="3" transform="rotate(-35 12 12)" {...stroke} />
    <path d="M9.6 14.4 14.4 9.6" {...stroke} />
  </>
);

/** A figure reaching over: head, a long bend, one leg out. */
const stretch = (
  <>
    <circle cx="9" cy="4.8" r="1.9" {...stroke} />
    <path d="M8 8.2c2.6 0 4.6 1.4 6 3.6" {...stroke} />
    <path d="M8 8.2c-1.5 2.3-2 4.6-1.4 7.1" {...stroke} />
    <path d="M6.6 15.3 5 20M6.6 15.3l4.4 1.4L14 20" {...stroke} />
  </>
);

/** Two footprints, one ahead of the other. */
const promenad = (
  <>
    <path d="M8.2 5.2c1.3 0 2 1.1 1.8 2.8-.2 1.6-.7 2.6-1.9 2.6s-1.8-1-1.6-2.6c.2-1.7.5-2.8 1.7-2.8Z" {...stroke} />
    <path d="M6.6 12.2c1.2-.5 2.4-.4 3.1.3" {...stroke} />
    <path d="M15.6 10.4c1.3 0 2 1.1 1.8 2.8-.2 1.6-.7 2.6-1.9 2.6s-1.8-1-1.6-2.6c.2-1.7.5-2.8 1.7-2.8Z" {...stroke} />
    <path d="M14 17.4c1.2-.5 2.4-.4 3.1.3" {...stroke} />
  </>
);

/** A crescent moon. Sleep. */
const somn = <path d="M19 14.5A8 8 0 0 1 9.2 4.8a7.6 7.6 0 1 0 9.8 9.7Z" {...stroke} />;

/** An open book, two pages and the spine. */
const bok = (
  <>
    <path d="M12 7.2C10.4 6 8.4 5.4 5.5 5.4H4v12h1.5c2.9 0 4.9.6 6.5 1.8" {...stroke} />
    <path d="M12 7.2c1.6-1.2 3.6-1.8 6.5-1.8H20v12h-1.5c-2.9 0-4.9.6-6.5 1.8" {...stroke} />
    <path d="M12 7.2V19" {...stroke} />
  </>
);

/** A toothbrush: handle, neck, bristles. */
const tand = (
  <>
    <path d="M7.5 20.5 14 14" {...stroke} />
    <rect x="13.2" y="5.4" width="5.4" height="7.2" rx="2" transform="rotate(45 15.9 9)" {...stroke} />
    <path d="M14.6 5.9 18 9.3" {...stroke} />
  </>
);

/** A sun with four rays. Daylight, which is a habit in a Nordic winter. */
const sol = (
  <>
    <circle cx="12" cy="12" r="3.6" {...stroke} />
    <path d="M12 3.2v2.2M12 18.6v2.2M3.2 12h2.2M18.6 12h2.2" {...stroke} />
    <path d="M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" {...stroke} />
  </>
);

/** Two breaths, one wide and one narrow, leaving. */
const andning = (
  <>
    <path d="M4 8.5h9.5a3 3 0 1 0-3-3" {...stroke} />
    <path d="M4 12.5h12a3 3 0 1 1-3 3" {...stroke} />
    <path d="M4 16.5h5.5" {...stroke} />
  </>
);

/** A pencil, nib down, with the line it has drawn. */
const penna = (
  <>
    <path d="M15.6 4.6 19.4 8.4 9.2 18.6l-4.6.8.8-4.6Z" {...stroke} />
    <path d="M14 6.2 17.8 10" {...stroke} />
  </>
);

const glyphs: Record<HabitIcon, ReactNode> = {
  droppe,
  tablett,
  stretch,
  promenad,
  somn,
  bok,
  tand,
  sol,
  andning,
  penna,
};

/** Every icon, in the order the picker shows them. */
export const HABIT_ICON_KEYS = HABIT_ICONS;

export function HabitIconGlyph({
  icon,
  size = 20,
}: {
  icon: string | null;
  size?: number;
}) {
  if (icon === null || !(icon in glyphs)) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {glyphs[icon as HabitIcon]}
    </svg>
  );
}
