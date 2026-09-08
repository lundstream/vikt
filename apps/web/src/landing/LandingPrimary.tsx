import type { ReactNode } from "react";

/**
 * The landing page's one primary action, in Lingon (D99).
 *
 * ## Why this is its own file
 *
 * §5's oldest rule is that Lingon belongs to two things: the trend line and the
 * wordmark. `colour-meaning.test.ts` holds that by naming the files allowed to
 * use the accent, and profile v1.2 adds exactly one exception to it:
 *
 * > Landningssidan är inte appen. Där finns en enda handling, och den primära
 * > knappen får Lingon. Inuti appen gäller regeln oförändrat: Lingon är
 * > trendlinjen och ordbilden, ingen knapp.
 *
 * An exception written as "the landing page may use Lingon" would be an
 * exception to a rule about *files*, and the guard would then permit the accent
 * anywhere on a page that is several hundred lines long. So the exception gets
 * a file of its own containing one element, and the guard names that file. The
 * boundary is then a thing a diff can show: any second use of Lingon has to
 * either live in here, where it is obvious, or fail the test.
 *
 * The reasoning behind the exception is worth keeping too. Inside the app,
 * Lingon means *your trend*, and it means that because it is never anything
 * else — a red button would spend the meaning on a control. The landing page is
 * not the app: nobody arriving on it has a trend line yet, there is no chart on
 * the page for the colour to be confused with, and there is exactly one thing
 * to do. The accent costs nothing there and buys the one action its emphasis.
 *
 * Which is also why this renders exactly one action and takes no variant. The
 * moment there are two Lingon buttons the argument above stops being true.
 */
export function LandingPrimary({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="inline-flex min-h-11 w-auto items-center justify-center rounded-lg bg-trend px-6
                 py-2.5 text-body font-medium text-paper transition-opacity hover:opacity-90"
      href={href}
    >
      {children}
    </a>
  );
}
