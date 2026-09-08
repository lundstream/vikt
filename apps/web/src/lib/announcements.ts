import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LOCALE, t } from "../i18n/index.js";

/**
 * Announcements, on the reader's side (D108).
 *
 * One query for all three things the shell needs — the banner, the news list and
 * the unread count — because two of them are read on every page and two round
 * trips for one row each is how a dashboard gains a second spinner.
 */

export type UserAnnouncement = {
  id: string;
  kind: "maintenance" | "news" | "notice";
  startsAt: string | null;
  endsAt: string | null;
  leadMinutes: number;
  title: string;
  body: string | null;
  published: boolean;
  sendMail: boolean;
  mailedAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  seen: boolean;
};

export const ANNOUNCEMENTS_KEY = ["announcements"] as const;

export function useAnnouncements() {
  return useQuery({
    queryKey: ANNOUNCEMENTS_KEY,
    queryFn: async () => {
      const response = await fetch("/api/announcements", { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{
        banner: UserAnnouncement | null;
        news: UserAnnouncement[];
        unread: number;
      }>;
    },
    // Not a figure anybody acts on, so a stale minute costs nothing, and this
    // runs on every page (D43 is about computed numbers, which these are not).
    staleTime: 60_000,
    retry: false,
  });
}

export function useMarkSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/announcements/${id}/seen`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ANNOUNCEMENTS_KEY }),
  });
}

/**
 * The maintenance body, rendered in the reader's own timezone.
 *
 * Client-side on purpose. The server knows the instant; only the browser knows
 * which zone to say it in, and a maintenance window announced in the server's
 * idea of time is how somebody in another country reads the wrong hour. The
 * app's day-boundary rule is the same principle (§3).
 *
 * A stored body wins: the default exists so an admin does not have to write one
 * for an ordinary restart, not to override them when they do.
 */
export function announcementBody(entry: UserAnnouncement): string {
  if (entry.body) return entry.body;
  if (entry.kind !== "maintenance" || !entry.startsAt) return "";

  const from = new Date(entry.startsAt);
  const to = entry.endsAt ? new Date(entry.endsAt) : from;

  return t("announce.defaultBody", {
    weekday: from.toLocaleDateString(LOCALE, { weekday: "long" }),
    date: from.toLocaleDateString(LOCALE, { day: "numeric", month: "long" }),
    from: from.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }),
    to: to.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }),
  });
}
