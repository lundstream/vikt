import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./Landing.js";
import { Privacy } from "./Privacy.js";
import { Terms } from "./Terms.js";
import { RequestCode } from "./RequestCode.js";
import "../styles/index.css";

/**
 * The public bundle's entry (D90, D106).
 *
 * Note what is **not** here: no `useServiceWorker`, no query client, no session,
 * and still no router. The service worker is scoped to `/app/` and is registered
 * only by the app's own entry, so this bundle cannot register one and cannot be
 * served by one. That is the property the whole move exists to get.
 *
 * `/integritet`, `/villkor` and `/kod` are served from this same HTML, so a
 * switch on the path is all the routing there is. `/kod` reaches this bundle
 * only where `REQUEST_ENABLED` is on: nginx 404s the path otherwise, and the
 * endpoint it posts to is not registered either (D127). The case below is what
 * renders once the request has already been let through, not what decides it. React Router would bring a history
 * stack, a link component and a context provider to choose between three static
 * pages that never navigate between each other without a full load, which is
 * the kind of thing that turns a 40 kB bundle into a 90 kB one for no gain.
 *
 * The paths are Swedish because the interface is (D21), and they are the URLs
 * the footer and the registration form link to.
 */

function publicPage() {
  switch (window.location.pathname.replace(/\/+$/, "")) {
    case "/integritet":
      return <Privacy />;
    case "/villkor":
      return <Terms />;
    case "/kod":
      return <RequestCode />;
    default:
      return <Landing />;
  }
}

createRoot(document.getElementById("landing")!).render(
  <StrictMode>{publicPage()}</StrictMode>,
);
