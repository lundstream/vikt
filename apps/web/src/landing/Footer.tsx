import { BeerIcon, GitHubMark, LicenceIcon, LockIcon, TermsIcon } from "./icons.js";
import { operatorOrNone, siteConfig } from "../lib/site-config.js";

/**
 * The footer, shared by the landing page and the two text pages (D106).
 *
 * An icon on every link rather than on the support button alone: one decorated
 * link in a row of plain ones reads as the important one, and it is not.
 *
 * Integritet and Villkor are real pages now rather than a list under the invite
 * form. That block said true things and covered about a third of what a service
 * other people use has to say, and a fold-out on a marketing page is the wrong
 * shape for a document somebody may need to read carefully or link to.
 */

const LICENCE = "https://www.gnu.org/licenses/agpl-3.0.html";

export function LandingFooter() {
  const { repo, support } = siteConfig();
  const operator = operatorOrNone();

  /*
    Support is optional and is dropped rather than shown empty (D121). Not every
    installation has somewhere to send a beer, and a link to nowhere is worse
    than one fewer link.
  */
  const links = [
    { href: repo, icon: <GitHubMark />, label: "GitHub", external: true },
    { href: "/integritet", icon: <LockIcon />, label: "Integritet", external: false },
    { href: "/villkor", icon: <TermsIcon />, label: "Villkor", external: false },
    { href: LICENCE, icon: <LicenceIcon />, label: "AGPL-3.0", external: true },
    ...(support === ""
      ? []
      : [{ href: support, icon: <BeerIcon />, label: "Bjud på en öl", external: true }]),
  ];

  return (
    <footer className="border-t border-edge">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-micro text-muted">
        {/*
          The operator's sentence is dropped when there is no operator to name
          (D177). It used to fall back to a description of the operator, so an
          installation that had not set `OPERATOR` said "drivs av den som driver
          den här installationen", which is a sentence eating its own tail.
        */}
        <span>
          Vikt körs av den som hostar den.{operator === null ? "" : ` Den här installationen drivs av ${operator}.`}
        </span>

        <span className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {links.map((link) => (
            <a
              key={link.label}
              className="inline-flex items-center gap-2 transition-colors hover:text-ink"
              href={link.href}
              {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            >
              {link.icon}
              {link.label}
            </a>
          ))}
        </span>
      </div>
    </footer>
  );
}
