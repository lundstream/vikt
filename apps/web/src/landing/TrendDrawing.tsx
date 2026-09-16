import type { CSSProperties } from "react";
import {
  driftField,
  fortnightGeometry,
  heroGeometry,
  HERO_BOX,
  NOISE_BOX,
} from "./seeded.js";

/**
 * The landing page's two graphs (D173, D177).
 *
 * ## Why this file exists at all
 *
 * `colour-meaning.test.ts` names the files allowed to use Lingon, and the rule
 * behind the list is that Lingon means **your trend line** and the wordmark.
 * The lines drawn here are trend lines, computed by the app's own EMA over
 * dated fixtures (`seeded.ts`), so this is not an exception to the rule. It is
 * the rule, on a page where the trend belongs to nobody.
 *
 * ## What the marks mean
 *
 * The same as in the app (profile, page 6): Is for the raw readings, Lingon for
 * the trend, and the endpoint is the mark itself (page 7).
 */

const LINE = {
  fill: "none",
  strokeWidth: 3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * The hero: thirty readings arrive, then the trend draws through them and ends
 * in its endpoint.
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
      {points.map((point, index) => (
        <circle
          key={`${point.x}-${point.y}`}
          className="hero-reading fill-data"
          cx={point.x}
          cy={point.y}
          r={2.6}
          style={{ "--i": index } as CSSProperties}
        />
      ))}

      <path className="hero-line stroke-trend" d={path} pathLength={1} {...LINE} />

      <circle className="hero-endpoint fill-trend" cx={end.x} cy={end.y} r={4.5} />
    </svg>
  );
}

/**
 * The field behind the hero: sparse, slow, and at an opacity where it is
 * texture rather than content.
 */
export function DriftField() {
  return (
    <svg className="h-full w-full" aria-hidden="true" focusable="false" preserveAspectRatio="none">
      {driftField().map((point) => (
        <circle
          key={`${point.x}-${point.y}`}
          className="drift-point fill-data"
          cx={`${point.x}%`}
          cy={`${point.y}%`}
          r={1.6}
          style={
            { "--delay": `${point.delay}s`, "--duration": `${point.duration}s` } as CSSProperties
          }
        />
      ))}
    </svg>
  );
}

/**
 * A fortnight of daily readings, with the trend drawn through them as the
 * reader scrolls.
 *
 * **Each reading appears as the line reaches it.** Every dot carries the
 * fraction of the line's length at which it sits, and `landing.css` turns the
 * section's scroll progress into its opacity, so the readings arrive under the
 * line rather than waiting in a cloud for it.
 *
 * **Progress only ever increases** (`landing-motion.ts`), so scrolling back up
 * leaves the line drawn. Nothing on this page animates in reverse.
 */
export function NoiseGraph() {
  const { points, vertices, path } = fortnightGeometry();
  const first = vertices[0]!.x;
  const span = vertices.at(-1)!.x - first;

  return (
    <svg
      viewBox={`0 0 ${NOISE_BOX.width} ${NOISE_BOX.height}`}
      className="h-auto w-full"
      role="img"
      aria-label="Fjorton dagliga vägningar med en trendlinje som faller jämnt genom dem."
    >
      {points.map((point) => (
        <circle
          key={`${point.x}-${point.y}`}
          className="noise-reading fill-data"
          cx={point.x}
          cy={point.y}
          r={3}
          /*
            Where the dot sits along the line, compressed into 0 to 0,92.
            At the full 0 to 1 the last reading's threshold is exactly 1, so it
            never crossed it and the fourteenth dot never appeared: measured,
            13 of 14 at the end of the scroll.
          */
          style={{ "--at": (((point.x - first) / span) * 0.92).toFixed(3) } as CSSProperties}
        />
      ))}

      <path className="noise-line stroke-trend" d={path} pathLength={1} {...LINE} />
    </svg>
  );
}
