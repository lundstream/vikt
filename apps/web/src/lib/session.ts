import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { meResponseSchema, type MeResponse } from "shared";
import { ApiError, api } from "./api.js";

export const ME_KEY = ["me"] as const;

/**
 * The last identity the server confirmed, kept so the app opens offline.
 *
 * Without this, Phase 6 does not work at all: the service worker serves the
 * shell, React boots, `GET /api/me` cannot be reached, and the app bounces to
 * the login screen — on a device that is signed in, holding a queue of entries
 * it cannot show. That was the actual behaviour before this existed, found by
 * pulling the network in a real browser rather than by any test.
 *
 * This is **not** the thing D43 rules out. D43 is about *computed figures*: a
 * maintenance number or a projection must never be shown stale, because acting
 * on a wrong one is the harm. Who you are is not a figure, it does not go out
 * of date between one morning and the next, and the server still checks the
 * session cookie on every write — so a cached identity can let you *see and
 * queue*, and can authorise nothing.
 *
 * `localStorage` rather than IndexedDB deliberately: this has to be readable
 * synchronously during the first render, before any await, or the app flashes
 * the login screen on every cold open.
 */
const IDENTITY_KEY = "vikt.identity";

function readCachedIdentity(): MeResponse | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw === null) return null;
    const parsed = meResponseSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // A private window, or a shape from an older version. Neither is worth
    // failing over: the app simply asks the server like it used to.
    return null;
  }
}

function writeCachedIdentity(user: MeResponse | null): void {
  try {
    if (user === null) localStorage.removeItem(IDENTITY_KEY);
    else localStorage.setItem(IDENTITY_KEY, JSON.stringify(user));
  } catch {
    // Storage refused. The app still works, it just will not open offline.
  }
}

/**
 * The session is whatever `GET /api/me` says it is, and while that cannot be
 * reached, whatever it last said.
 *
 * A 401 is a normal answer meaning signed out, not an error worth retrying, and
 * it clears the cached identity: being signed out is a fact the server just
 * stated, unlike a network failure, which states nothing.
 */
export function useMe() {
  /**
   * The cached identity is **initial data**, not an error fallback.
   *
   * The first attempt was to fall back once the query errored, and it did not
   * work: offline the query stays `pending/fetching` rather than settling, so
   * the app sat on "Laddar…" indefinitely. Waiting for a failure to be
   * *declared* is the wrong shape anyway — it means every cold open, online or
   * off, shows a spinner while a round trip decides something already known.
   *
   * As initial data the app renders immediately in both cases. The query still
   * runs (`initialDataUpdatedAt: 0` marks the seed as already stale), so a real
   * answer replaces it the moment one arrives, including a 401 that signs the
   * device out.
   */
  const cached = readCachedIdentity();

  const query = useQuery<MeResponse | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        const user = await api.me();
        writeCachedIdentity(user);
        return user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          writeCachedIdentity(null);
          return null;
        }
        throw error;
      }
    },
    // A 401 is an answer, not a failure. Anything else gets two attempts and
    // then stops: retrying forever is a spinner that never resolves, which §3
    // rules out as firmly as a stale number.
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) && count < 2,
    staleTime: 60_000,
    ...(cached !== null
      ? { initialData: cached, initialDataUpdatedAt: 0 }
      : {}),
  });

  return {
    ...query,
    /** True when the app is running on the remembered identity. */
    offline: query.isError && cached !== null,
  } as const;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.login,
    onSuccess: (user) => {
      queryClient.setQueryData(ME_KEY, user);
      writeCachedIdentity(user);
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.register,
    onSuccess: (user) => {
      queryClient.setQueryData(ME_KEY, user);
      writeCachedIdentity(user);
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.updateProfile,
    onSuccess: (user) => {
      queryClient.setQueryData(ME_KEY, user);
      writeCachedIdentity(user);
      // Sex and birth date feed the formula fallback, so maintenance changes.
      void queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.setQueryData(ME_KEY, null);
      // Signing out clears the cached identity, or the next cold open would
      // let a signed-out device back in to look at the last user's screens.
      writeCachedIdentity(null);
      void queryClient.invalidateQueries();
    },
  });
}
