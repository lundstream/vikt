import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * The admin screens' data layer (D100).
 *
 * Separate from `lib/api.ts` and deliberately thin. These endpoints answer
 * **404 rather than 403** for a non-admin (D89), so there is nothing here that
 * distinguishes "you may not" from "there is nothing here", and there should not
 * be: the whole point of that choice is that the two are indistinguishable from
 * outside.
 *
 * Every mutation invalidates the whole `["admin"]` key rather than the one list
 * it touched. Deleting an account changes the user list, the audit log and
 * possibly the mail queue, and a screen that refreshed only what the caller
 * remembered to name is a screen that shows a stale audit log after the action
 * that should have been the newest line in it.
 */

export type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string | null;
  disabledAt: string | null;
  isAdmin: boolean;
};

export type DeletionPreview = {
  email: string;
  weights: number;
  foodEntries: number;
  dailyLogs: number;
  photos: number;
};

export type AdminInvite = {
  code: string;
  createdAt: string;
  usedAt: string | null;
  expiresAt: string | null;
};

export type LogEntry = {
  id: string;
  actorEmail: string;
  action: string;
  subject: string | null;
  detail: string | null;
  createdAt: string;
};

export type InviteRequest = {
  id: string;
  email: string;
  /** Null on any row written before the form asked (D112). */
  name: string | null;
  reason: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  inviteCode: string | null;
};

export type QueuedMail = {
  id: string;
  toAddress: string;
  template: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
};

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

async function send<T>(url: string, method: "POST" | "DELETE", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

/* ------------------------------------------------------------------ reads */

export const useAdminRequests = () =>
  useQuery({
    queryKey: ["admin", "invite-requests"],
    queryFn: () =>
      get<{ requests: InviteRequest[]; mailEnabled: boolean }>("/api/admin/invite-requests"),
    retry: false,
  });

/**
 * Whether anything is draining the queue (D104).
 *
 * Null means no worker has ever ticked. That is the state which looked exactly
 * like "waiting its turn" for the hour two invite mails sat unsent.
 */
export type WorkerState = {
  lastTickAt: string;
  sentSinceStart: number;
  lastError: string | null;
};

export const useAdminMail = () =>
  useQuery({
    queryKey: ["admin", "mail"],
    queryFn: () =>
      get<{ mail: QueuedMail[]; worker: WorkerState | null }>("/api/admin/mail"),
    retry: false,
  });

export const useAdminUsers = () =>
  useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => get<{ users: AdminUser[] }>("/api/admin/users"),
    retry: false,
  });

export const useAdminInvites = () =>
  useQuery({
    queryKey: ["admin", "invites"],
    queryFn: () => get<{ invites: AdminInvite[] }>("/api/admin/invites"),
    retry: false,
  });

export const useAdminLog = () =>
  useQuery({
    queryKey: ["admin", "log"],
    queryFn: () => get<{ entries: LogEntry[] }>("/api/admin/log"),
    retry: false,
  });

/* -------------------------------------------------------------- mutations */

/** One hook per action, so a screen names what it is doing at the call site. */
function useAdminAction<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }),
  });
}

export const useSetDisabled = () =>
  useAdminAction((input: { id: string; disabled: boolean }) =>
    send<{ ok: true }>(`/api/admin/users/${input.id}/disabled`, "POST", {
      disabled: input.disabled,
    }),
  );

export const useDeleteUser = () =>
  useAdminAction((input: { id: string }) =>
    send<DeletionPreview>(`/api/admin/users/${input.id}`, "DELETE"),
  );

export const useResetForUser = () =>
  useAdminAction((input: { id: string }) =>
    send<{ ok: true; emailed: boolean }>(`/api/admin/users/${input.id}/reset`, "POST"),
  );

export const useMintInvite = () =>
  useAdminAction(() => send<{ code: string }>("/api/admin/invites", "POST"));

export const useRevokeInvite = () =>
  useAdminAction((input: { code: string }) =>
    send<{ ok: true }>(`/api/admin/invites/${encodeURIComponent(input.code)}`, "DELETE"),
  );

export const useRetryMail = () =>
  useAdminAction((input: { id: string }) =>
    send<{ ok: true }>(`/api/admin/mail/${input.id}/retry`, "POST"),
  );

/** What a delete would remove, fetched only when somebody asks (D95). */
export function deletionPreview(id: string): Promise<DeletionPreview> {
  return get<DeletionPreview>(`/api/admin/users/${id}/deletion`);
}
