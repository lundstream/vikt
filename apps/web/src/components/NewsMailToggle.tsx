import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../lib/session.js";
import { t } from "../i18n/index.js";

/**
 * Whether news announcements are also mailed (D108).
 *
 * **Only news.** Maintenance mail is not opt-out: it concerns the service the
 * person is using, and an outage nobody was told about is the failure the whole
 * announcement feature exists to prevent. News is something they might find
 * interesting, which is a different thing entirely. The hint says so here, and
 * /integritet says so where it counts.
 */
export function NewsMailToggle() {
  const me = useMe();
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: async (newsMail: boolean) => {
      const response = await fetch("/api/me/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newsMail }),
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  const on = me.data?.profile.newsMail ?? true;

  return (
    <section className="mt-10 border-t border-edge pt-6">
      <label className="flex items-start gap-3 text-body text-ink">
        <input
          type="checkbox"
          className="check mt-1"
          data-testid="news-mail"
          checked={on}
          disabled={save.isPending}
          onChange={(event) => save.mutate(event.target.checked)}
        />
        {t("settings.newsMail")}
      </label>
      <p className="mt-2 max-w-prose text-note text-muted">{t("settings.newsMailHint")}</p>
    </section>
  );
}
