import type { CSSProperties } from "react";
import {
  driftField,
  FORTNIGHT,
  fortnightGeometry,
  HERO_BOX,
  heroPath,
  heroPoints,
  NOISE_BOX,
} from "./seeded.js";

/**
 * The landing page's two graphs (D173).
 *
 * ## Why this file exists at all
 *
 * `colour-meaning.test.ts` names the files allowed to use Lingon, and the rule
 * behind the list is that Lingon means **your trend line** and the wordmark.
 * The lines drawn here are trend lines: the hero's is the shape the whole
 * product is about, and the second is a trend drawn through a fortnight of
 * daily readings. So this is not an exception to the rule the way
 * `LandingPrimary.tsx` is (profile page 4's one carve-out for the landing
 * page's single action). It is the rule, on a page where the trend happens to
 * be a drawing rather than somebody's data.
 *
 * It is still a file of its own, because the guard's list is a list of files
 * and a 400-line page in it would permit the accent anywhere on the page.
 *
 * ## Why the points are Is and the line is Lingon
 *
 * The same reason they are in the app (profile page 4): the raw readings are
 * secondary data behind the trend, and the trend is the thing. Somebody who has
 * used the app for a week should recognise this picture, because it is the same
 * picture.
 *
 * ## pathLength
 *
 * Both lines animate `stroke-dashoffset` from the path's length to zero, and
 * the length is `pathLength={1}`: SVG then treats the path as one unit long
 * whatever its real geometry, so the CSS needs no measurement and no
 * `getTotalLength()` call on load. Changing the curve cannot break the draw.
 */

const LINE = {
  fill: "none",
  strokeWidth: 3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * The hero: about thirty readings arrive, then the trend draws through them and
 * ends in its endpoint, which stays.
 *
 * Decorative to a screen reader. The section around it carries the sentence
 * that says what it means, and a description of a drawing of a line would be a
 * second, worse copy of that sentence.
 */
export function HeroGraph() {
  const points = heroPoints();

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

      <path className="hero-line stroke-trend" d={heroPath()} pathLength={1} {...LINE} />

      {/* The endpoint, which is the mark itself (profile page 7). */}
      <circle className="hero-endpoint fill-trend" cx={312} cy={128} r={4.5} />
    </svg>
  );
}

/**
 * The field behind the hero: sparse, slow, and at an opacity where it is
 * texture rather than content.
 *
 * Percentages rather than a viewBox, so it fills whatever the section is
 * without a second coordinate system to keep in step with the first.
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
 * A fortnight of daily readings in Is, with the trend drawn through them as the
 * reader scrolls.
 *
 * The scroll timeline is in `landing.css`; what this file decides is that the
 * fourteen dots are the noise and the one line is the answer, which is the
 * section's whole argument made as a picture.
 */
export function NoiseGraph() {
  const { points, path } = fortnightGeometry();

  return (
    <svg
      viewBox={`0 0 ${NOISE_BOX.width} ${NOISE_BOX.height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Fjorton dagliga vägningar mellan ${Math.min(...FORTNIGHT.readings)
        .toFixed(1)
        .replace(".", ",")} och ${Math.max(...FORTNIGHT.readings)
        .toFixed(1)
        .replace(".", ",")} kilo, med en trendlinje som faller jämnt genom dem.`}
    >
      {points.map((point) => (
        <circle
          key={`${point.x}-${point.y}`}
          className="fill-data"
          cx={point.x}
          cy={point.y}
          r={3}
        />
      ))}

      <path className="noise-line stroke-trend" d={path} pathLength={1} {...LINE} />
    </svg>
  );
}
