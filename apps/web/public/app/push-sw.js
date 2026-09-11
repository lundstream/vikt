/**
 * The push half of the service worker (D136).
 *
 * Imported by the generated worker rather than written into it: the worker
 * itself is produced by workbox from the build, and `importScripts` is how a
 * handful of hand-written handlers join it without taking over the whole file.
 *
 * Two events, and each one is about the same thing — the person is not looking
 * at the app, so everything has to be right first time.
 */

/**
 * A notification arrived.
 *
 * `event.waitUntil` is not optional: without it the worker can be stopped
 * before the notification is shown, and the browser then shows its own
 * "site has been updated in the background" instead, which is the worst
 * possible copy for a reminder somebody opted into.
 *
 * The payload is JSON the server encrypted to this device's keys. A payload
 * that will not parse is still shown, with the app's name, rather than dropped:
 * a reminder that arrives slightly wrong is better than one that vanishes.
 */
self.addEventListener("push", (event) => {
  let payload = { title: "Vikt", body: "", url: "/app/", tag: "vikt" };

  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Vikt", {
      body: payload.body,
      /**
       * The maskable icon, which is the one that survives being put in a round
       * mask by Android. Badge is the monochrome silhouette in the status bar.
       */
      icon: "/icon-maskable.svg",
      badge: "/icon.svg",
      /**
       * Collapses an older notification of the same kind. Two mornings without
       * opening the phone leaves one "dags att väga dig", not a stack.
       */
      tag: payload.tag || "vikt",
      renotify: false,
      /**
       * Not `requireInteraction`. A reminder that has to be dismissed is an
       * alarm, and §3's no-failure-state rule extends to not nagging: if it is
       * missed, tomorrow's is the next one.
       */
      data: { url: payload.url || "/app/" },
    }),
  );
});

/**
 * The notification was tapped.
 *
 * **Focus an open tab rather than opening a second one.** Somebody who already
 * has the app open and taps the reminder should land in the app they have, with
 * its queue and its state, not in a new copy beside it.
 *
 * The URL is matched loosely on origin, because the reminder points at
 * `/app/?logga` or `/app/dag` and an app open on `/app/framsteg` is still the
 * app: it is navigated rather than duplicated.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || "/app/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (!client.url.startsWith(self.location.origin)) continue;
          if (!client.url.includes("/app")) continue;
          if ("navigate" in client) {
            return client.navigate(target).then((navigated) => navigated && navigated.focus());
          }
          return client.focus();
        }
        return self.clients.openWindow(target);
      }),
  );
});
