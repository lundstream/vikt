import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { LogDateProvider } from "../../src/lib/log-date.js";

/**
 * Mounting a route, with the providers it expects and nothing else.
 *
 * These are **smoke tests**, not visual regression and not behaviour tests.
 * They assert one thing per route: it mounts and renders its heading. That
 * sounds trivially weak until you have shipped a blank page, which this project
 * has: a `const` read inside a callback before its declaration typechecks
 * cleanly, because TypeScript cannot prove when the callback runs, and it threw
 * at render. Nothing in the suite noticed. A screenshot did.
 *
 * So the bar is deliberately low and the coverage deliberately wide. Every
 * route, every time, proving it is not blank.
 *
 * Fetch is stubbed rather than mocked per-endpoint: what these tests are about
 * is the render path, and a route that renders its heading while its queries
 * are still pending is exactly the state a real cold load starts in.
 */

/**
 * A stub that remembers what was posted to it.
 *
 * The static stub answers every GET the same way forever, which cannot show
 * whether a list refetched after a write — the thing the "one entry behind" bug
 * was about. This one lets a test say "POST here appends to the list GET there
 * returns", so a stale read is visible as a stale read.
 */
export type StatefulRoute = {
  match: string;
  /** Current body for a GET. Called fresh on every request, with its URL. */
  get: (url: string) => unknown;
  /** Applies a POST or PUT body. Absent means the route is read-only. */
  post?: (body: unknown) => void;
  /**
   * What a write answers with. Defaults to `{}`.
   *
   * Needed by any screen that reads its own write's response — "did the probe
   * succeed" is not a question the next GET can answer.
   */
  wrote?: unknown;
  /**
   * How long the request takes.
   *
   * Needed to make a race a race. With an instantly-resolving stub the refetch
   * fired on enqueue happens to land after the POST, so a test written against
   * it passes with or without the fix. A network takes time; a POST that takes
   * time is what reproduces the entry-behind bug.
   */
  delayMs?: number;
};

export type RenderRouteOptions = {
  /** Seed the route the memory router opens on. */
  path?: string;
  /** Responses by URL fragment, for routes that need data to get past a gate. */
  responses?: { match: string; body: unknown }[];
  /**
   * URL fragments the stub should refuse with a 401.
   *
   * The auth screens need this: signed in, `Login` redirects, which is correct
   * behaviour and renders nothing. Testing them signed in would assert that a
   * redirect is a blank page.
   */
  unauthorized?: string[];
  /** Routes whose GET reflects what has been posted to them. */
  stateful?: StatefulRoute[];
};

/**
 * A query client that never retries and never caches between tests. Retries in
 * a test suite turn one failure into a timeout, which reports as the wrong bug.
 */
function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      /**
       * `gcTime: 0` was tempting for isolation and is wrong: a query with no
       * observer for an instant is collected before the observer reads it, so
       * the fetch happens and `data` stays undefined forever. A fresh client
       * per render is what actually isolates these.
       */
      queries: { retry: false, staleTime: 0, networkMode: "always" },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}

export function stubFetch(
  responses: RenderRouteOptions["responses"] = [],
  unauthorized: string[] = [],
  stateful: StatefulRoute[] = [],
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    const route = stateful.find((entry) => url.includes(entry.match));
    if (route) {
      /**
       * A GET is answered from the state as it was **when the request was
       * made**, not when it resolves. That is what a real server does, and it
       * is the only way this reproduces the bug: a refetch fired before the
       * POST landed has to come back without the new entry, however long the
       * response then takes to arrive.
       */
      // Deep-copied, not referenced. `get()` normally returns the live array a
      // test mutates in `post`, so holding the wrapper object would let the
      // response reflect writes that happened after the request was made.
      /**
       * A write is a POST **or a PUT**. The admin screens save with PUT, and a
       * stub that only recognised POST answered those from `get()` and dropped
       * the body on the floor, so a test asserting what a form sends passed
       * while asserting nothing.
       */
      const writing = method === "POST" || method === "PUT";
      const snapshot = writing ? null : JSON.parse(JSON.stringify(route.get(url) ?? null));

      if (route.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, route.delayMs));
      }
      if (writing && route.post) {
        route.post(init?.body ? JSON.parse(String(init.body)) : {});
      }
      const body = writing ? (route.wrote ?? {}) : snapshot;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }

    if (unauthorized.some((fragment) => url.includes(fragment))) {
      const body = { error: "unauthorized", message: "Inte inloggad." };
      return {
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }

    const match = responses.find((response) => url.includes(response.match));

    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => match?.body ?? {},
      text: async () => JSON.stringify(match?.body ?? {}),
    } as Response;
  }) as typeof fetch;
}

export function renderRoute(
  screen: ReactNode,
  options: RenderRouteOptions = {},
): RenderResult {
  /**
   * The cached identity in `localStorage` is initial data for `useMe`, so a
   * previous test signing in would leak into the next one's first render.
   */
  window.localStorage.clear();
  stubFetch(options.responses, options.unauthorized, options.stateful);

  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={[options.path ?? "/"]}>
        <LogDateProvider timezone="Europe/Stockholm">{screen}</LogDateProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
