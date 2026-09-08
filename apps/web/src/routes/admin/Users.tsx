import { useState } from "react";
import { formatLongDay } from "../../lib/dates.js";
import { LOCALE, t } from "../../i18n/index.js";
import { useMe } from "../../lib/session.js";
import { Sheet } from "../../components/Sheet.js";
import {
  deletionPreview,
  useAdminUsers,
  useDeleteUser,
  useResetForUser,
  useSetDisabled,
  type AdminUser,
  type DeletionPreview,
} from "./api.js";

/**
 * Accounts (D95, D100).
 *
 * The endpoints have existed since D95 and nothing called them. This is the
 * screen.
 *
 * Three actions, in increasing order of how much they cost to get wrong:
 * disable, which is reversible and drops the account's sessions; reset, which
 * mints a link and never a password; and delete, which is not reversible and is
 * therefore the only one that asks twice.
 */
export function Users() {
  const users = useAdminUsers();
  const me = useMe();
  const setDisabled = useSetDisabled();
  const reset = useResetForUser();

  /** The account a delete has been started for, with what it would remove. */
  const [pendingDelete, setPendingDelete] = useState<{
    user: AdminUser;
    preview: DeletionPreview;
  } | null>(null);

  /** The one-line outcome of the last action, said rather than merely done. */
  const [notice, setNotice] = useState<string | null>(null);

  async function startDelete(user: AdminUser) {
    setNotice(null);
    setPendingDelete({ user, preview: await deletionPreview(user.id) });
  }

  if (users.isLoading) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  const rows = users.data?.users ?? [];

  return (
    <section data-testid="admin-users">
      {notice ? (
        <p role="status" className="mb-4 text-note text-ink">
          {notice}
        </p>
      ) : null}

      <p className="mb-4 max-w-prose text-note text-muted">{t("admin.disableHint")}</p>

      {rows.length === 0 ? (
        <p className="text-note text-muted">{t("admin.noUsers")}</p>
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {rows.map((user) => (
            <li key={user.id} className="py-4" data-testid={`user-${user.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-body text-ink">{user.email}</span>
                  <span className="block truncate text-micro text-muted">
                    {user.displayName}
                  </span>
                </span>

                <span className="flex shrink-0 flex-wrap gap-2">
                  {user.isAdmin ? <span className="tag tag-quiet">{t("admin.userIsAdmin")}</span> : null}
                  {user.disabledAt ? (
                    <span className="tag tag-quiet">{t("admin.userDisabled")}</span>
                  ) : null}
                </span>
              </div>

              {/*
                Created and last seen, both stated. Last seen is the newest
                session's start (D95), which is when they last signed in rather
                than when they last opened the app, and the label says signed in
                for that reason.
              */}
              <p className="num mt-1 text-micro text-muted">
                {t("admin.userCreated", {
                  date: formatLongDay(user.createdAt.slice(0, 10), LOCALE),
                })}
                {" · "}
                {user.lastSeenAt
                  ? t("admin.userLastSeen", {
                      date: formatLongDay(user.lastSeenAt.slice(0, 10), LOCALE),
                    })
                  : t("admin.userNeverSeen")}
              </p>

              <div className="mt-2 flex flex-wrap gap-4">
                <button
                  type="button"
                  data-testid={`toggle-${user.id}`}
                  className="min-h-11 text-note text-ink underline underline-offset-4"
                  disabled={setDisabled.isPending}
                  onClick={() => {
                    setNotice(null);
                    setDisabled.mutate({ id: user.id, disabled: user.disabledAt === null });
                  }}
                >
                  {user.disabledAt ? t("admin.enable") : t("admin.disable")}
                </button>

                <button
                  type="button"
                  data-testid={`reset-${user.id}`}
                  className="min-h-11 text-note text-ink underline underline-offset-4"
                  disabled={reset.isPending}
                  onClick={() =>
                    reset.mutate(
                      { id: user.id },
                      {
                        onSuccess: (result) =>
                          setNotice(
                            result.emailed
                              ? t("admin.resetSent", { email: user.email })
                              : t("admin.resetNoMail"),
                          ),
                      },
                    )
                  }
                >
                  {t("admin.resetFor")}
                </button>

                {/*
                  Never for your own account. Deleting the admin you are signed
                  in as would cascade the session doing the deleting, and the
                  screen would come back as a 404 with no explanation.
                */}
                {user.id === me.data?.id ? (
                  <span className="min-h-11 text-note text-muted">
                    {t("admin.adminCannotDeleteSelf")}
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid={`delete-user-${user.id}`}
                    className="min-h-11 text-note text-muted underline underline-offset-4"
                    onClick={() => void startDelete(user)}
                  >
                    {t("admin.deleteUser")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <DeleteSheet
        pending={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onDeleted={(email) => {
          setPendingDelete(null);
          setNotice(t("admin.deleteDone", { email }));
        }}
      />
    </section>
  );
}

/**
 * The confirmation, which states its consequences (D95).
 *
 * "Delete user" is an abstraction. "84 vägningar, 113 matrader" is the thing
 * that is about to happen, and the counts come from the same tables the cascade
 * will empty rather than from a guess in a dialog.
 */
function DeleteSheet({
  pending,
  onClose,
  onDeleted,
}: {
  pending: { user: AdminUser; preview: DeletionPreview } | null;
  onClose: () => void;
  onDeleted: (email: string) => void;
}) {
  const remove = useDeleteUser();

  return (
    <Sheet
      open={pending !== null}
      onClose={onClose}
      title={t("admin.deleteUser")}
      testId="delete-user-sheet"
    >
      {pending ? (
        <>
          <p className="text-body text-ink">
            {t("admin.deleteWhat", { email: pending.preview.email })}
          </p>

          <ul className="num mt-3 space-y-1 text-note text-muted">
            <li>{t("admin.deleteWeights", { n: pending.preview.weights })}</li>
            <li>{t("admin.deleteFood", { n: pending.preview.foodEntries })}</li>
            <li>{t("admin.deleteDays", { n: pending.preview.dailyLogs })}</li>
            <li>{t("admin.deletePhotos", { n: pending.preview.photos })}</li>
          </ul>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              data-testid="confirm-delete-user"
              className="btn w-auto px-6"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { id: pending.user.id },
                  { onSuccess: () => onDeleted(pending.preview.email) },
                )
              }
            >
              {t("admin.deleteConfirm")}
            </button>
            <button type="button" className="btn-secondary w-auto px-6" onClick={onClose}>
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : null}
    </Sheet>
  );
}
