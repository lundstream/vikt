#!/usr/bin/env node
/**
 * The one way this repository talks to Portainer (D158).
 *
 * It exists because the alternative kept happening: a deploy is driven by
 * pasting a password into a session, the session is a transcript, and the
 * password then has to be rotated. A credential that has been in a chat is
 * burned, and the only reliable way not to put one there is to have no step
 * that asks for one.
 *
 * So: the token comes from the environment, and **this script never prompts**.
 * With `PORTAINER_TOKEN` unset it prints the variable name and exits 2. There
 * is no interactive fallback, no `-p` flag, and no username and password path
 * at all. Portainer's password-exchange endpoint is deliberately not called
 * from here, because calling it requires having the password somewhere to
 * send.
 *
 * The guard in `secrets-hygiene.test.ts` greps for that endpoint's path, so
 * it is not spelled out anywhere in this file, comments included. A guard a
 * comment can talk its way around is not a guard.
 *
 *   export PORTAINER_TOKEN=ptr_...        # see INFRA.md, "The Portainer token"
 *   node scripts/portainer.mjs check
 *   node scripts/portainer.mjs get /api/stacks
 *   node scripts/portainer.mjs get /api/endpoints/2/docker/containers/json
 *
 * `check` is the first thing to run after creating a token: it proves the token
 * works and prints which account it belongs to, so a token with the wrong role
 * is found now rather than half way through a deploy.
 */

/** Where Portainer is. Overridable, because the host is not a constant. */
const BASE = process.env.PORTAINER_URL ?? "http://192.168.1.20:9000";

/**
 * Everything this script prints passes through here (§7, D158 addendum).
 *
 * The script prints response bodies and error pages, and a body is whatever the
 * server chose to send. A proxy that reflects request headers into an error
 * page, or an endpoint that echoes its caller, would put the token straight
 * into stderr. `secrets-echo.test.ts` runs this against a server that does
 * exactly that, and before this function existed the token came out three
 * ways: a reflected success on stdout, an echoed body on stdout, and an error
 * page on stderr.
 *
 * Redacted rather than suppressed, so the output still says what happened. A
 * token shorter than eight characters is not redacted, because splitting on one
 * or two characters would mangle every line and no real token is that short.
 */
function redact(text) {
  const value = String(text);
  const token = process.env.PORTAINER_TOKEN?.trim();
  if (!token || token.length < 8) return value;
  return value.split(token).join("<redacted>");
}

const out = (text) => process.stdout.write(`${redact(text)}\n`);
const err = (text) => process.stderr.write(redact(text));

/**
 * The token, or a refusal.
 *
 * Exit 2 rather than 1, so a caller can tell "not configured" from "the request
 * failed". The message names the variable and points at the runbook, because
 * the person reading it is usually mid-deploy and does not want a search.
 */
export function requireToken() {
  const token = process.env.PORTAINER_TOKEN;

  if (!token || token.trim() === "") {
    process.stderr.write(
      [
        "PORTAINER_TOKEN is not set.",
        "",
        "This script does not prompt for a credential and has no password path.",
        "A secret typed into a prompt ends up in whatever is recording the",
        "session, which is how the last one had to be rotated.",
        "",
        "Create an access token in Portainer (My account, Access tokens) and",
        "export it:",
        "",
        "  export PORTAINER_TOKEN=ptr_...",
        "",
        'See INFRA.md, "The Portainer token", for which account to create it on.',
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

  return token.trim();
}

/**
 * One request, authenticated with the token.
 *
 * `X-API-Key` rather than a bearer JWT: an access token is the credential
 * Portainer issues for exactly this, it can be revoked on its own without
 * changing the account's password, and it never has to be exchanged for
 * anything, which is the step that would need the password.
 */
export async function portainer(path, { method = "GET", body } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "X-API-Key": requireToken(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();

  if (!response.ok) {
    const hint =
      response.status === 401
        ? "  The token was refused. It may be revoked, or belong to an account without access."
        : response.status === 403
          ? "  Authenticated, but this account may not have access to that resource."
          : "";
    err(`${method} ${path} -> HTTP ${response.status}\n${hint}\n${text.slice(0, 400)}\n`);
    process.exitCode = 1;
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------ cli -- */

const [command, path] = process.argv.slice(2);

try {
  if (command === "check") {
    const me = await portainer("/api/users/me");
    if (me) {
      // Role 1 is administrator in Portainer's own numbering; 2 is a standard
      // user. Printed rather than judged, because which one is right depends on
      // how the stack's access control is set (INFRA.md).
      out(`token works: ${me.Username} (role ${me.Role})`);
    }
  } else if (command === "get" && path) {
    const result = await portainer(path);
    if (result !== null) out(JSON.stringify(result, null, 2));
  } else if (command !== undefined) {
    err("usage: portainer.mjs check | get <path>\n");
    process.exitCode = 2;
  }
} catch (error) {
  /**
   * A request that never reached a server. Caught so the message goes through
   * `redact` like everything else, rather than node printing an unhandled
   * rejection with whatever the error happened to carry.
   */
  err(`request failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
