import type { CSSProperties } from "react";
import { heroGeometry, HERO_BOX, MARKS, type Reading } from "./seeded.js";

/**
 * The landing page's graph (D173, D177, D178, D179).
 *
 * ## Why this file is allowed Lingon
 *
 * `colour-meaning.test.ts` names the files allowed to use Lingon, and the rule
 * behind the list is that Lingon means **your trend line** and the wordmark.
 * The lines drawn here are trend lines, computed by the app's own EMA over
 * dated fixtures (`seeded.ts`), so this is not an exception to the rule. It is
 * the rule, on a page where the trend belongs to nobody.
 *
 * ## The marks are the app's marks
 *
 * Is for the raw readings, Lingon for the trend, and the endpoint is the mark
 * itself (profile, pages 6 and 7). The stroke width, the reading radius and the
 * endpoint radius are `TrendChart.tsx`'s own numbers, and the curve is the same
 * monotone interpolation, so what a stranger sees here is the line they will
 * see in the app rather than a drawing of one.
 *
 * ## The points and the line advance together
 *
 * Each reading knows where it sits along the line and when the line gets there
 * (`seeded.ts`); the hero delays each dot by the second of those, across the
 * same two seconds the line takes, so a reading appears just before the line
 * reaches it, left to right, in the order the readings happened. They used to
 * arrive as a cloud and then be crossed out by a line.
 *
 * ## There is one graph, not two
 *
 * "En dagsvikt är mest brus" had a second one, drawn by scrolling. It made the
 * same argument as the hero with the same marks, and a page that draws its
 * thesis twice has made the second drawing decoration. That section carries the
 * fourteen readings as figures now (D179), so this file has one export.
 */

const LINE = {
  fill: "none",
  strokeWidth: MARKS.strokeWidth,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * How far ahead of the line each reading appears, as a fraction of the run.
 *
 * Just ahead rather than exactly at it: a dot that appears under the line's cap
 * is hidden by it at the moment it arrives, and the point of the sequence is
 * that the reading comes first and the trend follows.
 */
const LEAD = 0.05;

/**
 * The hero times its dots against the clock, so it wants **when** the line
 * arrives rather than where the dot sits along it. `seeded.ts` computes both,
 * because the line draws on an ease-out and the two are not the same number;
 * the second reader of that pair was the fortnight's scroll-driven line, and
 * that is gone (D179).
 */
const arrives = (point: Reading) =>
  ({ "--enters": Math.max(0, point.enters - LEAD).toFixed(4) }) as CSSProperties;

/**
 * The hero: thirty readings and the trend through them, drawn together over two
 * seconds, ending in the endpoint.
 *
 * **The line enters from the left edge already settled.** It is drawn from the
 * vertex before the window (`seeded.ts`), so nothing marks where it starts; it
 * was computed over twice the history the picture shows.
 *
 * **The endpoint appears when the line reaches it**, not before. It used to be
 * timed a hundred milliseconds early, which put a full stop at the end of a
 * sentence still being written; the timings live together in `landing.css` so
 * the two cannot drift apart again.
 *
 * Decorative to a screen reader: the section around it carries the sentence
 * that says what it means.
 */
export function HeroGraph() {
  const { points, vertices, path } = heroGeometry();
  const end = vertices.at(-1)!;

  return (
    <svg
      viewBox={`0 0 ${HERO_BOX.width} ${HERO_BOX.height}`}
      className="h-auto w-full"
      aria-hidden="true"
      focusable="false"
    >
      {points.map((point) => (
        <circle
          key={point.localDate}
          className="hero-reading fill-data"
          cx={point.x}
          cy={point.y}
          r={MARKS.readingRadius}
          style={arrives(point)}
        />
      ))}

      <path className="hero-line stroke-trend" d={path} pathLength={1} {...LINE} />

      <circle
        className="hero-endpoint fill-trend"
        cx={end.x}
        cy={end.y}
        r={MARKS.endpointRadius}
      />
    </svg>
  );
}
