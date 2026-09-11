import webpush, { type PushSubscription, WebPushError } from "web-push";
import type { Env } from "../env.js";

/**
 * Web push, the transport (D136).
 *
 * This file knows how to send one notification to one device and what to do
 * when the push service refuses. It knows nothing about reminders, times or
 * timezones: that is `reminder.service.ts`, and keeping the two apart is what
 * lets the scheduler be tested without a network.
 *
 * ## Push is absent, not degraded, without keys
 *
 * No VAPID pair means `pushEnabled` is false, the subscribe endpoint is not
 * registered and the settings screen shows nothing about reminders. The same
 * rule the LLM surfaces follow (§6): an unavailable feature leaves no trace
 * rather than a disabled control that invites a support question.
 *
 * ## What the push service sees
 *
 * The endpoint, and that a message was sent. **Never its content**: the
 * payload is encrypted to keys the browser generated and the service cannot
 * read it. /integritet says so, because it is the sort of thing somebody is
 * entitled to know before turning it on.
 */

export type PushTarget = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushPayload = {
  title: string;
  body: string;
  /** Where a tap goes, as an app-relative path. */
  url: string;
  /**
   * Collapses an older notification of the same kind.
   *
   * Two mornings in a row without opening the phone should leave one "dags att
   * väga dig", not a stack. The push services all honour this and it costs a
   * string.
   */
  tag: string;
};

export function pushEnabled(env: Env): boolean {
  return env.VAPID_PUBLIC_KEY.trim() !== "" && env.VAPID_PRIVATE_KEY.trim() !== "";
}

/** Set once per process, because `web-push` keeps them in module state. */
export function configurePush(env: Env): void {
  if (!pushEnabled(env)) return;
  webpush.setVapidDetails(
    env.VAPID_SUBJECT.trim(),
    env.VAPID_PUBLIC_KEY.trim(),
    env.VAPID_PRIVATE_KEY.trim(),
  );
}

/**
 * What happened to one send, in the three shapes the caller acts on.
 *
 * `gone` is the important one: the push service is saying this subscription
 * will never work again, and the row has to go. Anything else is a transient
 * failure that is logged and left alone — the next reminder will try again,
 * and a queue that retries forever is a queue that grows forever.
 */
export type SendOutcome =
  | { status: "sent" }
  | { status: "gone"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Sends one notification.
 *
 * **404 and 410 mean the browser threw the subscription away** — the app was
 * uninstalled, site data was cleared, or the service expired it. Those are not
 * retried and not kept: the row is deleted on the first failure, which is what
 * §6 specifies and what stops a table filling with endpoints nothing will ever
 * accept again.
 *
 * 403 is included with them deliberately. It means the VAPID key does not
 * match the one the subscription was created with, which happens when somebody
 * regenerates the pair. The subscription is equally dead, and keeping it would
 * mean every future run retrying a row that can only fail.
 */
export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
): Promise<SendOutcome> {
  const subscription: PushSubscription = {
    endpoint: target.endpoint,
    keys: { p256dh: target.p256dh, auth: target.auth },
  };

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      /**
       * Four hours. A reminder that could not be delivered because the phone
       * was off is not worth showing at lunchtime — "late is worse than never"
       * is the rule, and this is the half of it the push service enforces even
       * when the device comes back before the app does.
       */
      TTL: 4 * 60 * 60,
      urgency: "normal",
    });
    return { status: "sent" };
  } catch (error) {
    if (error instanceof WebPushError) {
      const code = error.statusCode;
      if (code === 404 || code === 410 || code === 403) {
        return { status: "gone", reason: `push service returned ${code}` };
      }
      return { status: "failed", reason: `push service returned ${code}` };
    }
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
