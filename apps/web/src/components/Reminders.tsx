import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../lib/session.js";
import { useHabits } from "../lib/habits.js";
import { t } from "../i18n/index.js";

/**
 * The two reminders, and the permission they need (D136).
 *
 * ## Why each reminder has two times
 *
 * Because Saturday is not Tuesday. Somebody who weighs themselves at 07:00 on
 * the way to work does not want the phone at 07:00 on a Sunday, and the answer
 * before this was to turn the reminder off on Friday and remember to turn it
 * back on. So each reminder carries a weekday pair and a weekend pair, each
 * with its own switch, and off at the weekend is a setting rather than the
 * absence of one.
 *
 * Side by side under the reminder rather than stacked, so the two times can be
 * compared at a glance, and they still fit at 360 px because a clock is four
 * characters wide.
 *
 * ## Why the permission state is spelled out
 *
 * Three states and three different things to do about them, and a toggle alone
 * cannot express any of them. **Not asked** is fine and the switch asks.
 * **Granted** is fine and the switch just works. **Denied** is the one that
 * matters: the browser will not ask again, the toggle would appear to work and
 * nothing would ever arrive, and the only way out is the site settings the app
 * cannot open. So it is said in words, with what to do.
 *
 * ## Why the platform line sits here
 *
 * Push works in the browser on Android and on iOS **only once the app is
 * installed to the home screen**. That is a platform rule and not a bug, and
 * the person who needs to know it is the one about to turn on a reminder that
 * would never arrive. §6 is explicit that it belongs beside the switch rather
 * than in a help page.
 *
 * The install control itself is **not** rendered here, though §6 asks for it
 * nearby: Inställningar already has one as its own section (D116), and two
 * copies of one control on one screen is worse than either placement. This
 * section sits directly above it instead, so the line about iOS and the control
 * that answers it are adjacent, and D116's ordering — install, then what works
 * offline — survives.
 *
 * ## Why there is a test button
 *
 * So the first test of the arrangement is not tomorrow's reminder failing to
 * appear. A person who has allowed notifications still cannot tell whether the
 * subscription reached the server, and "wait until seven and see" is not a
 * diagnostic.
 */

type Device = {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

/** `420` becomes `07:00`. Stored as minutes, shown as a clock. */
function toClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function fromClock(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

/**
 * base64url to the bytes `pushManager.subscribe` wants.
 *
 * Typed as `ArrayBuffer` rather than `Uint8Array`, because `Uint8Array`'s
 * buffer may be a `SharedArrayBuffer` as far as the type system knows and
 * `applicationServerKey` will not take one. The value is the same bytes.
 */
function decodeKey(base64: string): ArrayBuffer {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

type Permission = "unsupported" | "default" | "granted" | "denied";

function readPermission(): Permission {
  if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  return Notification.permission as Permission;
}

export function Reminders() {
  const me = useMe();
  /**
   * The checklist, so this section can name the habits that remind. Read here
   * rather than duplicated: the habit's own sheet stays the only place to
   * change one.
   */
  const habits = useHabits();
  const queryClient = useQueryClient();
  const [permission, setPermission] = useState<Permission>(readPermission);
  const [notice, setNotice] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  /**
   * Whether the server has push at all. Absent keys mean the whole section is
   * not drawn: an unavailable feature leaves no trace, rather than a switch
   * that cannot work (§6).
   */
  const key = useQuery({
    queryKey: ["push", "key"],
    queryFn: async () => {
      const response = await fetch("/api/push/key", { credentials: "same-origin" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as { publicKey: string };
    },
    retry: false,
    staleTime: Infinity,
  });

  /** This browser's own endpoint, so the list can say which row is this one. */
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setEndpoint(subscription?.endpoint ?? null))
      .catch(() => setEndpoint(null));
  }, [permission]);

  const devices = useQuery({
    queryKey: ["push", "subscriptions", endpoint],
    enabled: key.data != null,
    queryFn: async () => {
      const url =
        endpoint === null
          ? "/api/push/subscriptions"
          : `/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`;
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      return ((await response.json()) as { subscriptions: Device[] }).subscriptions;
    },
    retry: false,
  });

  const saveProfile = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const response = await fetch("/api/me/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  /**
   * Asking, subscribing and telling the server, in that order.
   *
   * The three are one action from the user's side, and splitting them across
   * three controls would leave somebody stranded between "allowed" and
   * "subscribed" with nothing saying which.
   */
  const subscribe = useMutation({
    mutationFn: async () => {
      const granted = await Notification.requestPermission();
      setPermission(granted as Permission);
      if (granted !== "granted") return;

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key.data!.publicKey),
      });

      const json = subscription.toJSON();
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
          /** What this browser is, as well as it can be told from here. */
          label: navigator.userAgent.slice(0, 100),
        }),
      });

      setEndpoint(subscription.endpoint);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["push"] }),
  });

  const test = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/push/test", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as { devices: number; sent: number; removed: number };
    },
    onSuccess: (result) => {
      setNotice(
        result.sent > 0
          ? t("push.testSent", { count: String(result.sent) })
          : t("push.testNone"),
      );
      void queryClient.invalidateQueries({ queryKey: ["push", "subscriptions"] });
    },
    onError: () => setNotice(t("push.testFailed")),
  });

  const forget = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/push/subscriptions/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["push", "subscriptions"] }),
  });

  // Push is not configured on this installation: draw nothing at all.
  if (key.isLoading || key.data == null) return null;

  const profile = me.data?.profile;
  const subscribed = endpoint !== null;

  /** Habits with a reminder on either pair, in the order the checklist has. */
  const reminding = (habits.data ?? []).filter((habit) => habit.remind || habit.remindWeekend);

  return (
    <section className="mt-10 border-t border-edge pt-6" data-testid="reminders">
      <h2 className="text-base text-ink">{t("push.title")}</h2>
      <p className="mt-2 max-w-prose text-note text-muted">{t("push.what")}</p>

      {/*
        Where push works, beside the switch rather than in a help page (§6).
        The person who needs this is the one about to turn on a reminder that
        would never arrive.
      */}
      <p className="mt-2 max-w-prose text-micro text-muted">{t("push.where")}</p>

      {/* The permission state, in words, with what to do about it. */}
      {permission === "unsupported" ? (
        <p className="mt-3 max-w-prose text-note text-ink" data-testid="push-unsupported">
          {t("push.unsupported")}
        </p>
      ) : permission === "denied" ? (
        <p className="mt-3 max-w-prose text-note text-ink" data-testid="push-denied">
          {t("push.denied")}
        </p>
      ) : !subscribed ? (
        <div className="mt-3">
          <p className="max-w-prose text-note text-muted" data-testid="push-not-asked">
            {t("push.notAsked")}
          </p>
          <button
            type="button"
            data-testid="push-allow"
            className="btn mt-3 w-auto px-6"
            disabled={subscribe.isPending}
            onClick={() => subscribe.mutate()}
          >
            {t("push.allow")}
          </button>
        </div>
      ) : (
        <p className="mt-3 max-w-prose text-note text-muted" data-testid="push-granted">
          {t("push.granted")}
        </p>
      )}

      {/* The two reminders, each with a weekday time and a weekend one. */}
      {profile ? (
        <div className="mt-6 space-y-6">
          {(["weigh", "day"] as const).map((kind) => (
            /*
              A fieldset because the four controls under one reminder are one
              group, and the reminder's own name has to be what names them.
              Without it "Vardagar" is a checkbox that could belong to either
              reminder, for anybody not looking at the screen.
            */
            <fieldset key={kind}>
              <legend className="text-body text-ink">
                {t(kind === "weigh" ? "push.weighLabel" : "push.dayLabel")}
              </legend>

              {/*
                What the notification will actually say, before it is turned
                on. The copy is generated on the server, so these two strings
                exist here to be shown **and** so the copy guards cover them:
                a reminder is interface copy that happens to arrive somewhere
                else, and §5's rules do not stop applying at the edge of the
                app.
              */}
              <p className="mt-1 max-w-prose text-micro text-muted">
                {t("push.preview", {
                  text: t(kind === "weigh" ? "push.notifyWeigh" : "push.notifyDay"),
                })}
              </p>

              {/*
                The two days side by side. `-weekend` is the only difference in
                the test ids, so the weekday control keeps the name it had.
              */}
              <div className="mt-3 grid max-w-xs grid-cols-2 gap-4">
                {(
                  [
                    {
                      part: "",
                      dayLabel: t("push.weekdays"),
                      timeLabel: t("push.timeWeekdays"),
                      onKey: kind === "weigh" ? "remindWeigh" : "remindDay",
                      minuteKey: kind === "weigh" ? "remindWeighMinute" : "remindDayMinute",
                      on: kind === "weigh" ? profile.remindWeigh : profile.remindDay,
                      minute:
                        kind === "weigh" ? profile.remindWeighMinute : profile.remindDayMinute,
                    },
                    {
                      part: "-weekend",
                      dayLabel: t("push.weekend"),
                      timeLabel: t("push.timeWeekend"),
                      onKey: kind === "weigh" ? "remindWeighWeekend" : "remindDayWeekend",
                      minuteKey:
                        kind === "weigh" ? "remindWeighWeekendMinute" : "remindDayWeekendMinute",
                      on: kind === "weigh" ? profile.remindWeighWeekend : profile.remindDayWeekend,
                      minute:
                        kind === "weigh"
                          ? profile.remindWeighWeekendMinute
                          : profile.remindDayWeekendMinute,
                    },
                  ] as const
                ).map(({ part, dayLabel, timeLabel, onKey, minuteKey, on, minute }) => (
                  <div key={part}>
                    <label className="flex items-center gap-2 text-note text-ink">
                      <input
                        type="checkbox"
                        className="check"
                        data-testid={`remind-${kind}${part}`}
                        checked={on}
                        disabled={saveProfile.isPending}
                        onChange={(event) => saveProfile.mutate({ [onKey]: event.target.checked })}
                      />
                      {dayLabel}
                    </label>
                    <input
                      className="field num mt-1.5 w-full"
                      data-testid={`remind-${kind}${part}-time`}
                      aria-label={timeLabel}
                      defaultValue={toClock(minute)}
                      onBlur={(event) => {
                        const parsed = fromClock(event.target.value);
                        if (parsed !== null && parsed !== minute) {
                          saveProfile.mutate({ [minuteKey]: parsed });
                        } else {
                          event.target.value = toClock(minute);
                        }
                      }}
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      ) : null}

      {/*
        The habits that remind, named here and changed where they live (D142).

        One line, not a second editor. A habit's reminder belongs to the habit,
        and two places to set the same thing is how the two halves of the habit
        sheet drifted in the first place. This says what is on and where to
        change it.
      */}
      <p className="mt-6 max-w-prose text-micro text-muted" data-testid="habit-reminders">
        {reminding.length === 0
          ? t("push.habitsNone")
          : t("push.habitsOn", { names: reminding.map((habit) => habit.name).join(", ") })}
      </p>

      {/* Confirm the device works before trusting it with tomorrow morning. */}
      {subscribed ? (
        <div className="mt-6">
          <button
            type="button"
            data-testid="push-test"
            className="btn w-auto px-6"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t("push.testing") : t("push.test")}
          </button>
          {notice ? (
            <p role="status" className="mt-2 max-w-prose text-note text-ink" data-testid="push-notice">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* The devices, each removable from any other one (D56). */}
      {devices.data && devices.data.length > 0 ? (
        <ul className="mt-6 divide-y divide-edge border-y border-edge">
          {devices.data.map((device) => (
            <li key={device.id} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-note text-ink">
                  {device.label || t("push.unnamedDevice")}
                  {device.current ? ` · ${t("push.thisDevice")}` : ""}
                </span>
                <span className="num block text-micro text-muted">
                  {t("push.lastSeen", { date: device.lastSeenAt.slice(0, 10) })}
                </span>
              </span>
              <button
                type="button"
                data-testid={`forget-${device.id}`}
                className="btn-link shrink-0 text-micro"
                disabled={forget.isPending}
                onClick={() => forget.mutate(device.id)}
              >
                {t("push.forget")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
