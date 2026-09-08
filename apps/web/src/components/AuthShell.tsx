import type { ReactNode } from "react";
import { Logo } from "./Wordmark.js";

/**
 * The signed-out frame. Deliberately quiet: one column, one heading, the form.
 * Responsive down to 360px, per the quality floor in CLAUDE.md §5.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-12">
      <header className="mb-8">
        {/*
          The wordmark, in lingonberry.

          §5 reserves the accent for the trend line and the wordmark, and D50
          spells out that the logo is the single exception: a wordmark is
          identity rather than data, and it cannot be mistaken for a data mark
          because it never appears inside a chart. This is the one screen where
          it is the only thing on the page, so it is the one that most obviously
          should not have been rendering in default ink.

          The in-app headers stay quiet on purpose. There the name is a label
          above a figure or a nav, not the identity of the screen, and an accent
          there would compete with the line it is reserved for.
        */}
        {/* Mark plus wordmark, centred: the auth screens are where both go. */}
        {/*
          The heading carries the name; the logo draws it. Marking the drawn
          one decorative stops a screen reader announcing "Vikt" twice, which
          is what it did when the wordmark became a component.
        */}
        <h1 className="sr-only">{title}</h1>
        <Logo aria-hidden="true" />
        <p className="mt-1 text-note text-muted">{subtitle}</p>
      </header>
      {children}
    </main>
  );
}
