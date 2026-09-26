/**
 * Which account the harness signs in as, and signing in.
 *
 * The seeded development account by default: `SEED_EMAIL` and `SEED_PASSWORD`,
 * read by name from the environment or from the repository's `.env`, the same
 * pair `seed:dev` plants and `phone-shots.mjs` reads. **No credential is in a
 * tracked file**, and nothing here prints one: a missing one is reported by its
 * variable name (§7). A script that needs a second account names its variables
 * the same way (`HARNESS_EMAIL_2`, `HARNESS_PASSWORD_2`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./browser.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A variable by name: the environment first, then `.env`. Never printed. */
export function setting(name) {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  let text = "";
  try {
    text = readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch {
    // No file: the caller reports the name.
  }
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim();
  return value ? value : null;
}

/** The seeded account, or a named pair. Throws naming what is missing. */
export function account(emailName = "SEED_EMAIL", passwordName = "SEED_PASSWORD") {
  const email = setting(emailName) ?? (emailName === "SEED_EMAIL" ? "test@example.test" : null);
  const password = setting(passwordName);
  if (!email) throw new Error(`${emailName} is not set, in the environment or .env`);
  if (!password) throw new Error(`${passwordName} is not set, in the environment or .env`);
  return { email, password };
}

/**
 * Signs in through the login form, the way a person does, and reports whether
 * it worked. The values reach the page and nothing else.
 */
export async function signIn(page, origin, who = account()) {
  await page.size(390, 800, true);
  await page.goto(`${origin}/app/login`, 4000);
  if (await page.evaluate("!!document.querySelector('#password')")) {
    await page.evaluate(`(() => {
      const set = (selector, value) => {
        const el = document.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('#email', ${JSON.stringify(who.email)});
      set('#password', ${JSON.stringify(who.password)});
      document.querySelector('form').requestSubmit();
      return 1;
    })()`);
    await sleep(5000);
  }
  return page.evaluate("!location.pathname.startsWith('/app/login')");
}
