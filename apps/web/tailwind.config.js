/**
 * Colours are declared once in src/styles/tokens.css and referenced here, so
 * dark mode is a variable swap rather than a second set of class names.
 * See CLAUDE.md §5.
 *
 * @type {import('tailwindcss').Config}
 */

/**
 * A token, with working opacity modifiers.
 *
 * The tokens are real colours now rather than RGB channel triples, which means
 * `var(--ink)` is valid CSS anywhere a colour is accepted — including in the
 * hands of someone who reaches past this file. The cost is that `rgb(… / a)`
 * no longer composes, so opacity goes through `color-mix()`, which every
 * browser this app supports has had for years.
 *
 * `bg-ink/70` therefore works, and so does the raw `bg-[var(--ink)]` that used
 * to compile to a dropped declaration.
 */
const token = (name) =>
  ({ opacityValue }) =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      /**
       * Semantic names only (D86).
       *
       * The palette lives in `tokens.css` under the profile's own Norrland
       * names and is deliberately **not** exposed here: a class called
       * `text-gran` would let a component pick a colour because it liked it,
       * and the rule the whole profile rests on is that a colour stands for an
       * area rather than a feeling. `text-logged` cannot be misused that way,
       * because using it is a claim about what the thing is.
       */
      colors: {
        /* Surfaces and text. */
        paper: token("--paper"),
        card: token("--card"),
        field: token("--field"),
        edge: token("--edge"),
        ink: token("--ink"),
        muted: token("--muted"),

        /* The five areas. */
        trend: token("--trend"),
        logged: token("--logged"),
        data: token("--data"),
        reward: token("--reward"),
        /* Text on a Honung surface. Fixed dark in both themes: see tokens.css. */
        "on-reward": token("--on-reward"),
        nutrition: token("--nutrition"),
        uncertain: token("--uncertain"),
      },
      /**
       * 4 mm, which is what the profile specifies for a card corner. At the
       * 96 dpi CSS reference that is 15.12 px; 15 is the honest rounding and
       * the one the browser can hit exactly.
       */
      borderRadius: { card: "0.9375rem" },
      fontFamily: {
        // Numbers are the content here. Archivo carries the figures.
        sans: ["Inter", "system-ui", "sans-serif"],
        num: ["Archivo", "Inter", "system-ui", "sans-serif"],
      },
      /**
       * A real scale, so the page has a hierarchy rather than four sizes that
       * happen to differ. The hero trend weight is `figure`; the numbers on the
       * insight block are `metric`; everything else steps down from those.
       *
       * The two figure sizes are set tight, because a large number set at
       * normal tracking reads as loose at 56 px.
       */
      fontSize: {
        figure: ["3.5rem", { lineHeight: "1", letterSpacing: "-0.03em", fontWeight: "600" }],
        "figure-sm": ["2.75rem", { lineHeight: "1", letterSpacing: "-0.03em", fontWeight: "600" }],
        metric: ["1.75rem", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "600" }],
        "metric-sm": ["1.375rem", { lineHeight: "1.15", letterSpacing: "-0.015em", fontWeight: "600" }],
        title: ["1.125rem", { lineHeight: "1.3", letterSpacing: "-0.01em" }],
        body: ["0.9375rem", { lineHeight: "1.5" }],
        note: ["0.8125rem", { lineHeight: "1.45" }],
        /*
          There was a `meta` at 12/16 here for one line on the landing page
          (D179). That line is `note` now, one step below the paragraph it sits
          under (D181), and a size in the scale that nothing uses is one of the
          "four sizes that happen to differ" this comment warns about.
        */
        micro: ["0.6875rem", { lineHeight: "1.35", letterSpacing: "0.02em" }],
      },
    },
  },
  plugins: [],
};
