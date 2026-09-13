import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LOCALE, t } from "../../i18n/index.js";
import { AnnouncementBody } from "../../components/Announcement.js";

/**
 * Writing announcements (D108).
 *
 * Edit and delete ship with the create, per §3 and D56, which is why this is a
 * form that both makes and changes them rather than a create form plus a list
 * somebody has to go back and add editing to later.
 *
 * The body is optional and that is the useful part for maintenance: leaving it
 * empty renders the default sentence from the window, in **the reader's** own
 * timezone, so the admin writes two timestamps rather than a paragraph they
 * would have to get right in somebody else's hours.
 */

type Announcement = {
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
};

/** `2026-09-08T19:00:00.000Z` to what a `datetime-local` input wants. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const BLANK = {
  id: null as string | null,
  kind: "maintenance" as Announcement["kind"],
  startsAt: "",
  endsAt: "",
  leadMinutes: "1440",
  title: "",
  body: "",
  published: false,
  sendMail: false,
};

export function Announcements() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(BLANK);
  const [notice, setNotice] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["admin", "announcements"],
    queryFn: async () => {
      const response = await fetch("/api/admin/announcements", { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ announcements: Announcement[] }>;
    },
    retry: false,
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        kind: form.kind,
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
        leadMinutes: Number(form.leadMinutes) || 0,
        title: form.title,
        body: form.body.trim() === "" ? null : form.body,
        published: form.published,
        sendMail: form.sendMail,
      };

      const response = await fetch(
        form.id ? `/api/admin/announcements/${form.id}` : "/api/admin/announcements",
        {
          method: form.id ? "PUT" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<Announcement>;
    },
    onSuccess: () => {
      setForm(BLANK);
      setNotice(t("admin.announceSaved"));
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      void queryClient.invalidateQueries({ queryKey: ["announcements"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/admin/announcements/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      void queryClient.invalidateQueries({ queryKey: ["announcements"] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const rows = list.data?.announcements ?? [];

  return (
    <section data-testid="admin-announcements">
      <form onSubmit={submit} className="panel max-w-md space-y-4">
        <label className="block text-micro text-muted">
          {t("admin.announceKind")}
          <select
            id="announce-kind"
            className="select mt-1 w-full"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as Announcement["kind"] })}
          >
            <option value="maintenance">{t("admin.announceMaintenance")}</option>
            <option value="news">{t("admin.announceNews")}</option>
            <option value="notice">{t("admin.announceNotice")}</option>
          </select>
        </label>

        <label className="block text-micro text-muted">
          {t("admin.announceTitle")}
          <input
            id="announce-title"
            className="field mt-1 w-full"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>

        {form.kind === "maintenance" ? (
          <>
            {/*
              Stacked on a phone, side by side from `sm` up.

              A `datetime-local` input has a large intrinsic minimum width that
              a flex child cannot shrink below without `min-w-0`, so two of them
              in a row pushed the form past 360 px and cut the second one off.
              Caught by shoot2's overflow check rather than by looking.
            */}
            <div className="flex flex-col gap-4 sm:flex-row">
              <label className="block min-w-0 flex-1 text-micro text-muted">
                {t("admin.announceFrom")}
                <input
                  id="announce-from"
                  className="field mt-1 w-full"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              </label>
              <label className="block min-w-0 flex-1 text-micro text-muted">
                {t("admin.announceTo")}
                <input
                  id="announce-to"
                  className="field mt-1 w-full"
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                />
              </label>
            </div>

            <label className="block text-micro text-muted">
              {t("admin.announceLead")}
              <input
                id="announce-lead"
                className="field mt-1 w-full"
                inputMode="numeric"
                value={form.leadMinutes}
                onChange={(e) =>
                  setForm({ ...form, leadMinutes: e.target.value.replace(/\D/g, "") })
                }
              />
            </label>
          </>
        ) : null}

        <label className="block text-micro text-muted">
          {t("admin.announceBody")}
          <textarea
            id="announce-body"
            className="field mt-1 min-h-24 w-full"
            maxLength={4000}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
        </label>
        {form.kind === "maintenance" ? (
          <p className="text-micro text-muted">{t("admin.announceBodyHint")}</p>
        ) : null}

        {/*
          What the subset is, next to the box it applies to (D128). A formatting
          syntax nobody is told about is a formatting syntax nobody uses, and
          the alternative to saying it here is a person discovering that their
          asterisks came out as asterisks after the mail went to everybody.
        */}
        <p className="text-micro text-muted">{t("admin.announceFormatHint")}</p>

        {/*
          The preview, rendered by the same component the news page uses.

          Not an approximation of it: an announcement is written once and read
          by everybody, and it is mailed once and cannot be recalled. The one
          thing that makes that safe is seeing the actual rendering before
          pressing save, which means the preview has to be the renderer rather
          than something that looks like it.
        */}
        <section className="rounded-card border border-edge bg-card p-4">
          <h3 className="text-micro text-muted">{t("admin.announcePreview")}</h3>
          {form.title.trim() === "" && form.body.trim() === "" ? (
            <p className="mt-2 text-micro text-muted">{t("admin.announcePreviewEmpty")}</p>
          ) : (
            <div data-testid="announce-preview" className="mt-2">
              <p className="text-body text-ink">{form.title}</p>
              <AnnouncementBody markdown={form.body} baseLevel={3} className="mt-1" />
            </div>
          )}
        </section>

        <label className="flex items-center gap-2 text-micro text-muted">
          <input
            type="checkbox"
            className="check"
            data-testid="announce-published"
            checked={form.published}
            onChange={(e) => setForm({ ...form, published: e.target.checked })}
          />
          {t("admin.announcePublished")}
        </label>

        <label className="flex items-center gap-2 text-micro text-muted">
          <input
            type="checkbox"
            className="check"
            data-testid="announce-mail"
            checked={form.sendMail}
            onChange={(e) => setForm({ ...form, sendMail: e.target.checked })}
          />
          {t("admin.announceSendMail")}
        </label>

        <div className="flex gap-3">
          <button
            type="submit"
            data-testid="save-announcement"
            className="btn w-auto px-6"
            disabled={save.isPending || form.title.trim() === ""}
          >
            {t("profile.save")}
          </button>
          {form.id ? (
            <button
              type="button"
              className="btn-link w-auto px-6"
              onClick={() => setForm(BLANK)}
            >
              {t("common.cancel")}
            </button>
          ) : null}
        </div>
      </form>

      {notice ? (
        <p role="status" className="mt-4 text-note text-ink">
          {notice}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-6 text-note text-muted">{t("admin.announceNone")}</p>
      ) : (
        <ul className="mt-8 divide-y divide-edge border-y border-edge">
          {rows.map((entry) => (
            <li key={entry.id} className="py-3" data-testid={`announcement-${entry.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-body text-ink">{entry.title}</span>
                  <span className="block truncate text-micro text-muted">
                    {t(
                      entry.kind === "maintenance"
                        ? "admin.announceMaintenance"
                        : entry.kind === "news"
                          ? "admin.announceNews"
                          : "admin.announceNotice",
                    )}
                    {entry.published ? "" : ` · ${t("admin.announceDraft")}`}
                    {entry.mailedAt
                      ? ` · ${t("admin.announceMailed", {
                          date: new Date(entry.mailedAt).toLocaleDateString(LOCALE),
                        })}`
                      : ""}
                  </span>
                </span>

                <span className="flex shrink-0 gap-4">
                  <button
                    type="button"
                    data-testid={`edit-${entry.id}`}
                    className="min-h-11 text-note text-ink underline underline-offset-4"
                    onClick={() => {
                      setNotice(null);
                      setForm({
                        id: entry.id,
                        kind: entry.kind,
                        startsAt: toLocalInput(entry.startsAt),
                        endsAt: toLocalInput(entry.endsAt),
                        leadMinutes: String(entry.leadMinutes),
                        title: entry.title,
                        body: entry.body ?? "",
                        published: entry.published,
                        sendMail: entry.sendMail,
                      });
                    }}
                  >
                    {t("admin.announceEdit")}
                  </button>
                  <button
                    type="button"
                    data-testid={`delete-announcement-${entry.id}`}
                    className="min-h-11 text-note text-muted underline underline-offset-4"
                    onClick={() => remove.mutate(entry.id)}
                  >
                    {t("admin.announceDelete")}
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
