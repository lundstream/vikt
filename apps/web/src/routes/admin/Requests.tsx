import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatLongDay } from "../../lib/dates.js";
import { LOCALE, t } from "../../i18n/index.js";
import { useAdminRequests } from "./api.js";

/**
 * Invite requests (D89, D100).
 *
 * Moved out of `Admin.tsx` unchanged when that file became a shell with tabs.
 * The behaviour is the one D89 specified: approving mints a code and queues the
 * mail, rejecting deletes the row and sends nothing.
 */
export function Requests() {
  const requests = useAdminRequests();
  const queryClient = useQueryClient();
  const [shownCode, setShownCode] = useState<{ id: string; code: string } | null>(null);

  const act = useMutation({
    mutationFn: async (input: { id: string; action: "approve" | "reject" | "delete" }) => {
      const url =
        input.action === "delete"
          ? `/api/admin/invite-requests/${input.id}`
          : `/api/admin/invite-requests/${input.id}/${input.action}`;
      const response = await fetch(url, {
        method: input.action === "delete" ? "DELETE" : "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ code?: string; emailed?: boolean }>;
    },
    onSuccess: (result, input) => {
      /**
       * When mail is off, the code is shown once, here, and the owner passes it
       * on by hand. That is the whole degraded path (D88) and it has to be
       * visible rather than merely recorded, because an approval whose code
       * nobody read is an approval that did nothing.
       */
      if (input.action === "approve" && result.emailed === false && result.code) {
        setShownCode({ id: input.id, code: result.code });
      }
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  const pending = requests.data?.requests.filter((row) => row.status === "pending") ?? [];
  const decided = requests.data?.requests.filter((row) => row.status !== "pending") ?? [];

  return (
    <section data-testid="admin-requests">
      {requests.data && !requests.data.mailEnabled ? (
        <p className="mb-6 max-w-prose text-note text-muted">{t("admin.mailOff")}</p>
      ) : null}

      <h2 className="mb-2 text-base text-ink">{t("admin.pending")}</h2>
      {pending.length === 0 ? (
        <p className="text-note text-muted">{t("admin.nonePending")}</p>
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {pending.map((row) => (
            <li key={row.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="min-w-0">
                  {/*
                    The name leads when there is one, because this list is read
                    to decide about a person and the address is the identifier
                    rather than the thing being judged (D112). Rows from before
                    the field existed have none and still read correctly.
                  */}
                  <span className="block truncate text-body text-ink">
                    {row.name ?? row.email}
                  </span>
                  {row.name ? (
                    <span className="block truncate text-micro text-muted">{row.email}</span>
                  ) : null}
                  <span className="num block text-micro text-muted">
                    {formatLongDay(row.createdAt.slice(0, 10), LOCALE)}
                  </span>
                </span>
                <span className="flex shrink-0 gap-3">
                  <button
                    type="button"
                    data-testid={`approve-${row.id}`}
                    className="min-h-11 px-1 text-note text-ink underline underline-offset-4"
                    onClick={() => act.mutate({ id: row.id, action: "approve" })}
                    disabled={act.isPending}
                  >
                    {t("admin.approve")}
                  </button>
                  <button
                    type="button"
                    data-testid={`reject-${row.id}`}
                    className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
                    onClick={() => act.mutate({ id: row.id, action: "reject" })}
                    disabled={act.isPending}
                  >
                    {t("admin.reject")}
                  </button>
                </span>
              </div>
              {row.reason ? (
                <p className="mt-1 max-w-prose text-micro text-muted">{row.reason}</p>
              ) : null}
              {shownCode?.id === row.id ? (
                <p className="num mt-2 text-note text-ink">
                  {t("admin.codeIs", { code: shownCode.code })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {decided.length > 0 ? (
        <div className="mt-10">
          <h2 className="mb-2 text-base text-ink">{t("admin.decided")}</h2>
          <ul className="divide-y divide-edge border-y border-edge">
            {decided.map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-3 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-note text-ink">{row.email}</span>
                  <span className="num block text-micro text-muted">{row.inviteCode ?? ""}</span>
                </span>
                <button
                  type="button"
                  data-testid={`delete-${row.id}`}
                  className="min-h-11 shrink-0 px-1 text-micro text-muted underline underline-offset-4"
                  onClick={() => act.mutate({ id: row.id, action: "delete" })}
                >
                  {t("delete.action")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
