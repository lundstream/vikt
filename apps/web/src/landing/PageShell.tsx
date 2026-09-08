import type { ReactNode } from "react";
import { HeaderLockup } from "../components/Wordmark.js";
import { LandingFooter } from "./Footer.js";

/**
 * The frame the two text pages share (D106).
 *
 * Same header lockup and same footer as the landing page, so /integritet and
 * /villkor read as part of the same site rather than as two documents somebody
 * bolted on. A back link rather than a nav: there is exactly one place to go
 * from here.
 */
export function PageShell({
  title,
  updated,
  children,
}: {
  title: string;
  /** When the text last changed. A privacy page with no date is a claim with no age. */
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-5">
        <a href="/" aria-label="Vikt">
          <HeaderLockup />
        </a>
        <a
          className="text-note text-muted underline underline-offset-4 hover:text-ink"
          href="/"
        >
          Tillbaka
        </a>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 pb-16 pt-4">
        <h1 className="text-figure-sm text-ink">{title}</h1>
        <p className="mt-2 text-micro text-muted">Senast ändrad {updated}.</p>
        {children}
      </main>

      <LandingFooter />
    </div>
  );
}

/**
 * A section heading, with a rule as wide as its own words (D111).
 *
 * The rule used to be `w-16`: a fixed 4 rem stub, the same length under every
 * heading. Under "Om AI" that is wider than the words and reads as an
 * underline, which is the one thing a heading must not look like. Under "Vad
 * som lagras och varfor" it stops a quarter of the way across and reads as a
 * fragment. One length cannot be right for both.
 *
 * The width comes from the text itself, with no measuring and no JavaScript:
 * the words sit in a shrink-to-fit box, and the rule is positioned to that
 * box's edges. When a heading wraps to two lines the box becomes the column and
 * the rule spans it, which is still the width of the heading.
 *
 * Absolutely positioned rather than a block under the words, so it takes no
 * height. Otherwise it lands inside the flex row and pushes the icon down by
 * half its own height relative to the text it is supposed to sit beside.
 */
export function RuledHeading({
  children,
  icon,
  size = "text-title",
  rule = true,
}: {
  children: ReactNode;
  icon?: ReactNode;
  /** The type scale step. The two pages are quieter than the landing sections. */
  size?: string;
  /**
   * Whether to draw the rule at all (D114).
   *
   * The rule's job is to say "a section starts here". An icon in a tinted
   * square says the same thing louder, so a heading with one gets both and
   * needs neither twice. The four capability headings have icons and no rule;
   * the three plain ones have the rule and no icon. One separator per heading.
   */
  rule?: boolean;
}) {
  return (
    <h2 className={`flex items-center gap-3 ${size} text-ink`}>
      {icon}
      <span className="relative">
        {children}
        {rule ? (
          <span
            className="absolute inset-x-0 top-full mt-2 block h-px bg-muted"
            aria-hidden="true"
          />
        ) : null}
      </span>
    </h2>
  );
}

/**
 * A section on one of the two text pages (D106, D111).
 *
 * Shared because /integritet and /villkor had the same helper twice and it is
 * the kind of duplication where one copy quietly stops matching the other.
 */
export function TextSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-10">
      <RuledHeading>{title}</RuledHeading>
      {/*
        The gap allows for the rule, which hangs below the heading's own box
        without taking height: 8 px down, 1 px tall, then the paragraphs.
      */}
      <div className="mt-6 space-y-3 text-body text-muted">{children}</div>
    </section>
  );
}
