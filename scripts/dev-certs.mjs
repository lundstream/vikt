/**
 * Generates the local development certificate.
 *
 *   pnpm dev:certs
 *
 * Writes `infra/certs/dev-{cert,key}.pem`, valid for localhost and for this
 * machine's LAN address, so the dev server can speak HTTPS and the phone can
 * reach it. See `docs/secure-context.md` for why that is mandatory rather than
 * tidy: the camera, the barcode scanner and `crypto.randomUUID` are all
 * secure-context only, and none of them exist over plain http on a LAN IP.
 *
 * The one-time `mkcert -install` is deliberately *not* run from here. It writes
 * to the system trust store and raises a Windows consent dialog, which has to be
 * clicked by a person; doing it silently from a package script would be the
 * wrong shape even if it worked.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certDir = path.join(root, "infra", "certs");

/** Every non-internal IPv4 address, so the cert covers however the phone connects. */
function localAddresses() {
  const found = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) found.add(address.address);
    }
  }
  return [...found];
}

function mkcert(args) {
  return execFileSync("mkcert", args, { cwd: certDir, encoding: "utf8" });
}

mkdirSync(certDir, { recursive: true });

try {
  mkcert(["-version"]);
} catch {
  process.stderr.write(
    [
      "",
      "mkcert is not on PATH.",
      "  Windows:  winget install FiloSottile.mkcert",
      "  macOS:    brew install mkcert",
      "",
      "Then run this again. Or skip certificates entirely and use a tunnel:",
      "  pnpm dev:tunnel",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const names = localAddresses();
mkcert(["-cert-file", "dev-cert.pem", "-key-file", "dev-key.pem", ...names]);

const caRoot = mkcert(["-CAROOT"]).trim();
const trusted = (() => {
  try {
    // `-install` is idempotent and prints a short message either way; we only
    // want to know whether it has already happened, so check for the CA file.
    return existsSync(path.join(caRoot, "rootCA.pem"));
  } catch {
    return false;
  }
})();

process.stdout.write(
  [
    "",
    `Certificate written to infra/certs, valid for: ${names.join(", ")}`,
    "",
    "Next, once per machine:",
    "  mkcert -install        (raises a trust prompt — accept it)",
    "",
    "And once per phone, to stop the browser warning:",
    `  copy ${path.join(caRoot, "rootCA.pem")} to the device and install it`,
    "  Android: Settings > Security > Encryption & credentials > Install a certificate > CA",
    "  iOS: install the profile, then Settings > General > About > Certificate Trust Settings",
    "",
    "If that is more trouble than it is worth, `pnpm dev:tunnel` gives a public",
    "HTTPS URL with a real certificate and needs nothing installed on the phone.",
    "",
    trusted ? "" : "The local CA does not look installed yet.",
  ].join("\n"),
);
