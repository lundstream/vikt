import webpush from "web-push";

/**
 * Generates a VAPID key pair (D136).
 *
 *   pnpm --filter api vapid
 *
 * Push needs a key pair that identifies **this server** to the push services
 * the browsers use. The pair is generated once per installation and then left
 * alone: changing it invalidates every subscription, because a subscription is
 * bound to the public key it was created with. Every device would silently
 * stop receiving reminders, and the app would have no way to notice.
 *
 * Printed as environment lines rather than written to a file, because the file
 * an operator keeps their secrets in differs by deployment and this script has
 * no business guessing. The private key is a secret like `SECRET_KEY`; the
 * public key is handed to every browser that subscribes, which is its job.
 */
const keys = webpush.generateVAPIDKeys();

process.stdout.write(
  [
    "",
    "A VAPID key pair for this installation. Add these to your .env or to the",
    "stack's environment, then restart the API.",
    "",
    "Keep VAPID_PRIVATE_KEY as secret as SECRET_KEY. Changing the pair later",
    "invalidates every existing subscription, so generate it once.",
    "",
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    "VAPID_SUBJECT=mailto:you@example.com",
    "",
  ].join("\n"),
);
