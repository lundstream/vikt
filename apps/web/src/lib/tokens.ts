import { useEffect, useState } from "react";

/**
 * Reads the design tokens as real colour strings.
 *
 * The tokens live as CSS custom properties so dark mode is a variable swap
 * (styles/tokens.css). SVG presentation attributes do not resolve `var()`,
 * though, and Recharts sets `stroke` and `fill` as attributes — so the values
 * have to be read out of the computed style and handed over as strings.
 *
 * Re-read when the theme class on `<html>` changes, otherwise the chart keeps
 * the old palette after a theme switch.
 */

/**
 * The semantic names, not the palette (D86).
 *
 * Charts read these for the same reason components use the semantic Tailwind
 * classes: a chart that asked for `--lingon` would be asking for a red, and
 * what it actually wants is *the trend*, which is a different question with a
 * stable answer across both themes.
 */
const TOKEN_NAMES = [
  "paper", "card", "field", "edge", "ink", "muted",
  "trend", "logged", "data", "reward", "nutrition", "uncertain",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = Record<TokenName, string>;

/** Tokens are real colours (`#16232b`), readable straight into an attribute. */
function read(): Tokens {
  const style = getComputedStyle(document.documentElement);
  const tokens = {} as Tokens;
  for (const name of TOKEN_NAMES) {
    const value = style.getPropertyValue(`--${name}`).trim();
    tokens[name] = value || "currentColor";
  }
  return tokens;
}

export function useTokens(): Tokens {
  const [tokens, setTokens] = useState<Tokens>(read);

  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return tokens;
}

/**
 * A token at partial opacity, for the faint marks behind the trend line.
 *
 * `color-mix` rather than string surgery on an `rgb()`: the tokens are hex now,
 * and SVG presentation attributes accept `color-mix` the same as any colour.
 */
export function alpha(color: string, opacity: number): string {
  if (color === "currentColor") return color;
  return `color-mix(in srgb, ${color} ${Math.round(opacity * 100)}%, transparent)`;
}

/** Honours the user's reduced-motion setting. Charts animate by default. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * Whether the viewport is wide enough for a dense, multi-column screen.
 *
 * `matchMedia` rather than a resize listener: the browser already computes this
 * and only notifies when the answer changes, so there is nothing to throttle.
 * Matches Tailwind's `lg`, so the JS and the CSS agree about what "wide" is
 * instead of having two thresholds that drift.
 */
const WIDE_QUERY = "(min-width: 1024px)";

export function useIsWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(WIDE_QUERY).matches === true,
  );

  useEffect(() => {
    const media = window.matchMedia?.(WIDE_QUERY);
    if (!media) return;

    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return wide;
}
