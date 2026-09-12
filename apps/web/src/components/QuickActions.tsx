import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { t, type TranslationKey } from "../i18n/index.js";

/**
 * The three things someone opens this app to do.
 *
 * Round icon buttons with the label underneath, the shape a banking app puts at
 * the top of its home screen. The reason that shape works is that the label is
 * always visible: an icon alone has to be learned, and these are used once a
 * day by someone who is not paying full attention.
 *
 * **This replaced the bottom bar's centre button rather than joining it (D53).**
 * The bar's plus was one raised affordance that meant "log" and did exactly one
 * thing — open the weight sheet — so a user who tapped it wanting to log a meal
 * got the wrong sheet with no way to tell in advance. Expanding it into three
 * would have fixed the ambiguity by adding a second navigation layer over the
 * one already at the bottom of the screen: a tap to open, an overlay to dismiss,
 * labels that exist only while it is open. These are one tap, always labelled,
 * always visible, and the bar goes back to being four evenly spaced
 * destinations with no notch cut into it.
 *
 * What that costs: the fast path is on the dashboard rather than on every
 * screen. The bar reaches the dashboard in one tap from anywhere, and the food
 * screen has its own scan and search controls, so the loss is one tap on the
 * rarer case.
 */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export type QuickAction = {
  key: string;
  label: TranslationKey;
  icon: ReactNode;
  /** Either a destination or an action; exactly one. */
  to?: string;
  onClick?: () => void;
  testId?: string;
};

/** A scale: a platform, a dial, and a needle. Not a plus sign. */
const scaleIcon = (
  <>
    <rect x="3" y="8" width="18" height="12" rx="2.5" {...stroke} />
    <path d="M12 8V5M8 5h8" {...stroke} />
    <path d="M12 17v-3.5l2.5-2" {...stroke} />
  </>
);

/**
 * A barcode inside a scanner frame, which is what the camera is about to do —
 * the previous control used the generic plus and read as "add something".
 */
export const barcodeIcon = (
  <>
    <path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4H7" {...stroke} />
    <path d="M21 8V5.5A1.5 1.5 0 0 0 19.5 4H17" {...stroke} />
    <path d="M3 16v2.5A1.5 1.5 0 0 0 4.5 20H7" {...stroke} />
    <path d="M21 16v2.5a1.5 1.5 0 0 1-1.5 1.5H17" {...stroke} />
    <path d="M7.5 8.5v7M10.5 8.5v7M13.5 8.5v7M16.5 8.5v7" {...stroke} />
  </>
);

/**
 * The three ways into the food screen's other surfaces (D135).
 *
 * Drawn to the profile's line set: no fill, `currentColor`, 1.75 stroke, round
 * caps and joins, on the same 24-unit grid as the three above. They are read at
 * 24 px inside a 56 px circle, so each one is carried by its **silhouette**
 * rather than by detail. Held to the same test as `mealIcon`: cover the label
 * and the three still have to be tellable apart.
 */

/** A pen, nib down, with the stroke it has just drawn. "Skriv in själv". */
export const penIcon = (
  <>
    <path d="M15.5 4.5l4 4L9 19l-5 1 1-5Z" {...stroke} />
    <path d="M13.5 6.5l4 4" {...stroke} />
  </>
);

/**
 * A speech bubble with its tail, for "skriv vad du åt".
 *
 * Deliberately not three dots inside it: at 24 px the dots close up into a
 * smudge, and the empty bubble reads as "say something" more plainly than a
 * bubble that appears to be already talking.
 */
export const speechIcon = (
  <>
    <path
      d="M20 5.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 15.5h2v4l4.5-4H20a1.5 1.5 0 0 0 1.5-1.5V7A1.5 1.5 0 0 0 20 5.5Z"
      {...stroke}
    />
  </>
);

/**
 * A pot with two handles and a lid, for "vad kan jag laga".
 *
 * Wider than it is tall, which is what separates it from `mealIcon`'s bowl at a
 * glance: the bowl is a shallow arc with steam, this is a rectangle with a rim.
 */
export const potIcon = (
  <>
    <path d="M4.5 9.5h15v6.5a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3Z" {...stroke} />
    <path d="M2.5 11.5h2M19.5 11.5h2" {...stroke} />
    <path d="M8 6.5h8" {...stroke} />
  </>
);

/**
 * A camera body with a lens, for photographing the plate (D143).
 *
 * The scanner's icon is a barcode inside a frame and this one is the camera
 * itself, which is the distinction that matters on the row: one of them is
 * about reading a code and the other is about the food. A lens rather than a
 * shutter, because a circle in a rectangle is a camera at 24 px and a shutter
 * is a smudge.
 */
export const cameraIcon = (
  <>
    <path
      d="M4 7.5h3l1.5-2h7L17 7.5h3A1.5 1.5 0 0 1 21.5 9v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 17V9A1.5 1.5 0 0 1 4 7.5Z"
      {...stroke}
    />
    <circle cx="12" cy="13" r="3.5" {...stroke} />
  </>
);

/** A bowl with steam. Distinct in silhouette from both of the others. */
const mealIcon = (
  <>
    <path d="M3 12h18a9 9 0 0 1-9 8 9 9 0 0 1-9-8Z" {...stroke} />
    <path d="M9 8c0-1.5 1-1.5 1-3M14 8c0-1.5 1-1.5 1-3" {...stroke} />
  </>
);

export function quickActions(input: { onLogWeight: () => void }): QuickAction[] {
  return [
    {
      key: "weight",
      label: "action.logWeight",
      icon: scaleIcon,
      onClick: input.onLogWeight,
      testId: "quick-weight",
    },
    /**
     * A link into the food screen with the scanner already opening, the same
     * pattern the bar's old plus used for `/?logga`. The camera and its
     * permission prompt belong to one screen; a second copy on the dashboard
     * would be a second place for `getUserMedia` to fail.
     */
    { key: "scan", label: "action.scan", icon: barcodeIcon, to: "/food?skanna", testId: "quick-scan" },
    { key: "food", label: "action.logFood", icon: mealIcon, to: "/food", testId: "quick-food" },
  ];
}

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <nav aria-label={t("action.section")}>
      <ul className="flex items-start justify-center gap-8 sm:gap-10">
        {actions.map((action) => (
          <li key={action.key}>
            <ActionButton action={action} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * `--edge` rather than the accent. §5 reserves lingonberry for the trend line
 * and the wordmark (D50), and three accent-coloured circles at the top of the
 * dashboard would outweigh the line they sit above.
 *
 * Exported, because the food screen's scan control is *this* control rather
 * than one that looks like it. Two components drifting apart is how the same
 * action ended up as a round button in one place and a full-width filled bar in
 * another.
 */
export function ActionButton({
  action,
  labelled = true,
}: {
  action: QuickAction;
  /**
   * Whether the label is printed under the circle.
   *
   * On the dashboard it is: three unlabelled icons in a row have to be learned,
   * and these are used once a day by someone not paying full attention. Beside
   * the search field on Mat it is not, because there the control sits in a row
   * with a text input and a label underneath makes it taller than everything
   * next to it, so nothing shares a centre line.
   *
   * The accessible name is unaffected either way. It moves onto the control
   * itself when the visible label is dropped, rather than being lost with it.
   */
  labelled?: boolean;
}) {
  const label = t(action.label);

  const inner = (
    <>
      <span
        aria-hidden="true"
        /**
         * A Dis circle with a Snö icon, Gran when pressed (profile, page 3 and
         * page 6). The profile names these explicitly among the three things
         * that never get an accent at rest: they are the way *into* an area,
         * not the area itself, and colouring them would say a quick action is a
         * kind of thing rather than a door to one.
         */
        className="grid size-14 place-items-center rounded-full border border-edge
                   bg-field text-ink transition-colors group-hover:border-muted
                   group-active:border-logged group-active:bg-logged/20"
      >
        <svg viewBox="0 0 24 24" className="size-6">
          {action.icon}
        </svg>
      </span>
      {labelled ? (
        <span className="block text-center text-micro text-muted">{label}</span>
      ) : null}
    </>
  );

  const className = labelled
    ? "group flex w-16 flex-col items-center gap-2"
    : "group flex shrink-0 items-center";

  return action.to ? (
    <Link
      to={action.to}
      data-testid={action.testId}
      className={className}
      {...(labelled ? {} : { "aria-label": label })}
    >
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      data-testid={action.testId}
      onClick={action.onClick}
      className={className}
      {...(labelled ? {} : { "aria-label": label })}
    >
      {inner}
    </button>
  );
}
