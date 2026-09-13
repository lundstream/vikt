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
 * Every step this project will consider, finest first, filtered by the caller's
 * constraints.
 *
 * Exported so a test can assert what is and is not admissible rather than
 * inferring it from the output.
 */
export function candidateSteps(
  range: number,
  maxStep?: number,
  quantum?: number,
): number[] {
  if (!Number.isFinite(range) || range <= 0) return [1];

  const magnitude = Math.pow(10, Math.floor(Math.log10(range)));
  const steps: number[] = [];

  for (const exponent of [-2, -1, 0, 1]) {
    for (const multiple of [1, 2, 2.5, 5]) {
      const step = multiple * magnitude * Math.pow(10, exponent);
      if (step <= 0) continue;
      if (maxStep !== undefined && step > maxStep + 1e-9) continue;

      if (quantum !== undefined && quantum > 0) {
        const multiples = step / quantum;
        if (Math.abs(multiples - Math.round(multiples)) > 1e-6) continue;
      }

      steps.push(step);
    }
  }

  return steps.length > 0 ? steps : [range];
}

/** The marks a given step puts inside `[min, max]`, de-duplicated on the label. */
function marksFor(
  min: number,
  max: number,
  step: number,
  format: (value: number) => string,
): number[] {
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

/**
 * Round ticks inside `[min, max]`, de-duplicated on the **rendered** label.
 *
 * The de-duplication is not decoration: the trend axis once rendered "108"
 * twice, because two different values rounded to the same string at one decimal
 * place. Comparing formatted output is the only check that matches what the
 * reader actually sees.
 *
 * ## The step is chosen by counting, not by estimating
 *
 * `floor(range / step) + 1` is how many marks a step *would* place if the first
 * one sat exactly on `min`. It does not: it sits on the first multiple of the
 * step at or above `min`, which is usually higher, so the estimate is often one
 * too many. On a 3,1 kg window that difference decided between a step of 1 —
 * three marks on the chart this product is about — and a step of 0.5, which is
 * six.
 *
 * So every admissible step is tried, the marks are built, and the one that
 * actually lands the most marks without exceeding `count` wins. That is also
 * what keeps the result in the four-to-six band without a second rule saying so:
 * the finest step that fits is the one with the most marks under the cap.
 *
 * When nothing fits — a capped `maxStep` on a wide window — the coarsest
 * admissible step is used and the axis simply gets more marks. The cap is a
 * promise about the scale; `count` is only a preference.
 */
export function niceTicks(
  min: number,
  max: number,
  count: number,
  format: (value: number) => string,
  maxStep?: number,
  quantum?: number,
): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];

  const steps = candidateSteps(max - min, maxStep, quantum);

  let best: number[] | null = null;
  let coarsest: number[] | null = null;

  for (const step of steps) {
    const marks = marksFor(min, max, step, format);
    coarsest = marks;

    if (marks.length <= count && (best === null || marks.length > best.length)) {
      best = marks;
    }
  }

  return best ?? coarsest ?? [];
}
