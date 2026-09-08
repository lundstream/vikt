/**
 * Round axis ticks inside a domain that is not round.
 *
 * A domain comes from the data plus padding, so dividing it into equal parts
 * gives marks like `85,6 / 87,5 / 89,4 / 91,3 / 93,2`: evenly spaced, all
 * correct, and all meaningless. An axis is a ruler, and a ruler is marked at
 * halves and whole numbers rather than at whatever the data happened to span.
 *
 * One implementation, used by both charts. The trend chart had its own and the
 * correlation view relied on Recharts' defaults, which is how the same defect
 * came to be fixed in one place and left in the other.
 */

/**
 * The smallest round step that fits `count` marks or fewer into `range`.
 *
 * Smallest, not "the first one bigger than range / count": rounding the raw
 * step up lands on 1 kg for a two-kilo window, which is three marks on the
 * element the whole product is about. Trying candidates in order and taking the
 * first that fits gives 0.5 there and 2 on a wide window.
 *
 * 2.5 is in the progression because weight moves in half-kilos, so 0.25 and 2.5
 * are both steps a reader of these axes expects to see.
 */
export function niceStep(range: number, count: number, maxStep?: number): number {
  if (!Number.isFinite(range) || range <= 0) return 1;

  const magnitude = Math.pow(10, Math.floor(Math.log10(range)));
  let fallback: number | null = null;

  for (const exponent of [-2, -1, 0, 1]) {
    for (const multiple of [1, 2, 2.5, 5]) {
      const step = multiple * magnitude * Math.pow(10, exponent);
      if (step <= 0) continue;
      /**
       * `maxStep` caps how coarse the axis may get. The weight axis passes 1
       * kg: on a six-kilo window the first step that fits five marks is 2, and
       * a scale marked in two-kilo jumps cannot show the half-kilo the whole
       * product is about. When the cap means no candidate fits `count`, the
       * coarsest allowed step is used and the axis simply gets more marks —
       * the cap is a promise about the scale, `count` only a preference.
       */
      if (maxStep !== undefined && step > maxStep + 1e-9) continue;

      // The epsilon is load-bearing: `0.05 / 0.01` is 4.999999999999999, so
      // without it this accepts a step that actually produces six marks.
      if (Math.floor(range / step + 1e-9) + 1 <= count) return step;
      // The coarsest step the cap still allows, kept for when none fit.
      if (maxStep !== undefined) fallback = step;
    }
  }

  // Capped and nothing fit: the cap wins, and the axis gets more marks.
  if (fallback !== null) return fallback;
  return range / Math.max(1, count - 1);
}

/**
 * Round ticks inside `[min, max]`, de-duplicated on the **rendered** label.
 *
 * The de-duplication is not decoration: the trend axis once rendered "108"
 * twice, because two different values rounded to the same string at one decimal
 * place. Comparing formatted output is the only check that matches what the
 * reader actually sees.
 */
export function niceTicks(
  min: number,
  max: number,
  count: number,
  format: (value: number) => string,
  maxStep?: number,
): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];

  const step = niceStep(max - min, count, maxStep);
  const ticks: number[] = [];
  const seen = new Set<string>();

  // Start at the first multiple of `step` at or above `min`, so the marks are
  // round numbers rather than offsets from an arbitrary lower bound.
  const first = Math.ceil(min / step - 1e-9) * step;

  for (let i = 0; ; i++) {
    // Multiply rather than accumulate: repeated addition of 0.5 drifts, and a
    // tick of 87.49999999 formats as "87,5" while comparing as something else.
    const value = Math.round((first + step * i) / step) * step;
    if (value > max + 1e-9) break;

    const label = format(value);
    if (seen.has(label)) continue;
    seen.add(label);
    ticks.push(value);
  }

  return ticks;
}
