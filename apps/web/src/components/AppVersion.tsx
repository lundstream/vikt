import { useQuery } from "@tanstack/react-query";
import { siteConfig } from "../lib/site-config.js";
import { t } from "../i18n/index.js";

/**
 * Which build this is, and where the source is (D151).
 *
 * At the foot of Inställningar, in Sten, because it is reference rather than
 * something anybody came here to do. Two jobs:
 *
 * **Saying which version is running.** The first question of every incident,
 * and the answer used to be somewhere between a Portainer image tag and a
 * guess. It comes from `/api/health`, which is where the boot log's own first
 * line gets it, so the screen and the log cannot disagree.
 *
 * **Offering the source.** AGPL §13 obliges an offer of the source to anybody
 * who interacts with the program over a network, which is every user of a
 * hosted Vikt. The landing page's footer has carried the link since D106, and
 * somebody signed in never sees that footer: the app is where they are.
 *
 * The other links are here because this is the page people look at when they
 * want to know what the thing is, and hunting for the terms from inside the app
 * previously meant signing out.
 */

const LICENCE = "https://www.gnu.org/licenses/agpl-3.0.html";

type Health = { version?: string; commit?: string };

/**
 * The same figure, read the same way, wherever it is shown.
 *
 * Exported so Administration and Inställningar cannot drift into two answers:
 * one query key, one cache entry, one request for the life of the tab.
 */
export function useBuildLabel(): string {
  const health = useQuery({
    queryKey: ["app", "health"],
    queryFn: async (): Promise<Health> => {
      const response = await fetch("/api/health", { credentials: "same-origin" });
      if (!response.ok) return {};
      return (await response.json()) as Health;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const version = health.data?.version ?? "";
  const commit = (health.data?.commit ?? "").slice(0, 7);
  if (version === "") return "";
  return commit === "" ? version : `${version} · ${commit}`;
}

/** One line under the Administration heading. Sten, no link, no action. */
export function AdminBuild() {
  const label = useBuildLabel();
  return (
    <p className="num text-micro text-muted" data-testid="admin-version">
      {label === "" ? t("about.versionUnknown") : t("about.version", { version: label })}
    </p>
  );
}

export function AppVersion() {
  const { repo } = siteConfig();

  const label = useBuildLabel();

  const links: { href: string; label: string; external: boolean }[] = [
    ...(repo === "" ? [] : [{ href: repo, label: t("about.source"), external: true }]),
    { href: "/app/nyheter", label: t("news.title"), external: false },
    { href: "/integritet", label: t("about.privacy"), external: false },
    { href: "/villkor", label: t("about.terms"), external: false },
    { href: LICENCE, label: "AGPL-3.0", external: true },
  ];

  return (
    <section className="mt-10 border-t border-edge pt-4" data-testid="app-version">
      {/*
        The figure first and the links under it, both in Sten. Nothing here is
        an action, so nothing here is a button (D134).
      */}
      <p className="num text-micro text-muted" data-testid="version-line">
        {label === "" ? t("about.versionUnknown") : t("about.version", { version: label })}
      </p>

      <p className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-micro text-muted">
        {links.map((link) => (
          <a
            key={link.label}
            className="underline underline-offset-4 hover:text-ink"
            href={link.href}
            {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {link.label}
          </a>
        ))}
      </p>
    </section>
  );
}
