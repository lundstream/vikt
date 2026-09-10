import { randomBytes } from "node:crypto";
import type { RegisterRequest, LoginRequest, Theme } from "shared";
import { themeSchema } from "shared";
import { toNumber, toNumberOrNull } from "shared";
import type { Db } from "../db/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { hashToken, newSessionToken } from "../auth/tokens.js";
import {
  findUsableInvite,
  markInviteUsed,
} from "../repositories/invites.repo.js";
import {
  deleteAllSessionsForUser,
  deleteSession,
  findSessionByTokenHash,
  insertSession,
} from "../repositories/sessions.repo.js";
import {
  findProfile,
  findUserByEmail,
  findUserById,
  insertProfile,
  insertUser,
} from "../repositories/users.repo.js";
import { conflict, notFound, unauthorized, unprocessable } from "../lib/errors.js";
import { countPendingInviteRequests } from "./invite-request.service.js";

/**
 * Registration, login, session resolution.
 *
 * `register`, `login` and `resolveSession` are the documented exceptions to the
 * userId-first rule (services/README.md): they run before there is a user to
 * scope to. They are listed in the eslint rule's allowlist so the exemption is
 * explicit rather than accidental. Everything after them takes `userId` first.
 */

export type SessionUser = { userId: string; sessionId: string };

export type AuthedUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  /** Whether the admin screens are reachable. Authorises nothing (D89, D100). */
  isAdmin: boolean;
  /** Invite requests waiting for an answer, or 0 for a non-admin (D129). */
  pendingRequests: number;
  /** When this account agreed to the privacy text, or null (D107). */
  consentedAt: string | null;
  profile: {
    /** Null until the user fills it in (D105). */
    heightCm: number | null;
    birthDate: string | null;
    sex: "male" | "female" | "unspecified";
    timezone: string;
    locale: string;
    activityFactor: number;
    addExerciseToTarget: boolean;
    soberAssumeUnloggedDry: boolean;
    /** Whether news announcements are also mailed (D108). */
    newsMail: boolean;
    /** Whether an admin is mailed about a new invite request (D129). */
    requestMail: boolean;
    /** Which theme to use: system, dark or light (D117). */
    theme: Theme;
    lastDrinkOn: string | null;
    /** Grams, null meaning "use the derived value" (D52). */
    macroOverrides: {
      proteinG: number | null;
      carbsG: number | null;
      fatG: number | null;
      fiberG: number | null;
    };
  };
};

type Deps = {
  db: Db;
  sessionTtlDays: number;
};

/** The plaintext token is returned exactly once, to be put in the cookie. */
export type IssuedSession = { token: string; expiresAt: Date };

async function issueSession(
  userId: string,
  deps: Deps,
  userAgent: string | null,
): Promise<IssuedSession> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + deps.sessionTtlDays * 24 * 60 * 60 * 1000);
  await insertSession(userId, deps.db, {
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: userAgent?.slice(0, 500) ?? null,
  });
  return { token, expiresAt };
}

/**
 * Invite-only. The invite is burned in the same transaction that creates the
 * user, and the burn re-checks `used_by IS NULL`, so two people racing on one
 * code cannot both get in.
 */
export async function register(
  deps: Deps,
  input: RegisterRequest,
  userAgent: string | null,
): Promise<{ user: AuthedUser; session: IssuedSession }> {
  const invite = await findUsableInvite(deps.db, input.inviteCode);
  if (!invite) {
    throw unprocessable("invalid_invite", "That invite code is not valid, or has been used.");
  }

  const existing = await findUserByEmail(deps.db, input.email);
  if (existing) {
    throw conflict("email_taken", "That email address is already registered.");
  }

  const passwordHash = await hashPassword(input.password);

  const userId = await deps.db.transaction(async (tx) => {
    const user = await insertUser(tx, {
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      /**
       * The moment the box was ticked (D107). Recorded here rather than
       * defaulted in the column, because a default would record consent for
       * accounts that never gave any.
       */
      consentedAt: new Date(),
    });
    await insertProfile(user.id, tx, {
      /**
       * Absent at registration (D105). The profile row still exists, because
       * everything else on it has a default and a missing row would be a
       * different and much worse kind of absence.
       */
      heightCm: null,
      timezone: input.timezone,
    });
    const burned = await markInviteUsed(tx, input.inviteCode, user.id);
    if (!burned) {
      // Somebody else used the code between the check above and here.
      throw unprocessable("invalid_invite", "That invite code has just been used.");
    }
    return user.id;
  });

  const user = await getMe(userId, deps.db);
  const session = await issueSession(userId, deps, userAgent);
  return { user, session };
}

export async function login(
  deps: Deps,
  input: LoginRequest,
  userAgent: string | null,
): Promise<{ user: AuthedUser; session: IssuedSession }> {
  const row = await findUserByEmail(deps.db, input.email);

  // Verify against a throwaway digest when the account does not exist, so the
  // response time does not tell an attacker which emails are registered.
  const digest = row?.passwordHash ?? (await decoyHash());
  const ok = await verifyPassword(digest, input.password);

  if (!row || !ok || row.disabledAt !== null) {
    throw unauthorized("Wrong email or password.");
  }

  const user = await getMe(row.id, deps.db);
  const session = await issueSession(row.id, deps, userAgent);
  return { user, session };
}

/**
 * Turns a cookie token into a user id, or undefined. Called on every request
 * that hits `requireAuth`, so it is one indexed lookup and nothing more.
 */
export async function resolveSession(
  db: Db,
  token: string,
): Promise<SessionUser | undefined> {
  const row = await findSessionByTokenHash(db, hashToken(token));
  if (!row) return undefined;
  if (row.expiresAt.getTime() <= Date.now()) return undefined;
  return { userId: row.userId, sessionId: row.id };
}

export async function logout(userId: string, db: Db, token: string): Promise<void> {
  await deleteSession(userId, db, hashToken(token));
}

export async function logoutEverywhere(userId: string, db: Db): Promise<void> {
  await deleteAllSessionsForUser(userId, db);
}

/** The `GET /api/me` payload. Parses the numeric boundary (CLAUDE.md §3). */
export async function getMe(userId: string, db: Db): Promise<AuthedUser> {
  const user = await findUserById(userId, db);
  if (!user) throw notFound("No such user.");

  const profile = await findProfile(userId, db);
  if (!profile) throw notFound("This account has no profile row.");

  /**
   * How many requests are waiting, for the marker on the admin entry (D129).
   *
   * Only asked for an admin: for everybody else the answer is always zero and
   * a count query on every `/me` would be work done to produce a constant.
   */
  const pendingRequests = user.isAdmin ? await countPendingInviteRequests(db) : 0;

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    isAdmin: user.isAdmin,
    pendingRequests,
    consentedAt: user.consentedAt?.toISOString() ?? null,
    profile: {
      heightCm: toNumberOrNull(profile.heightCm),
      birthDate: profile.birthDate,
      sex: profile.sex,
      timezone: profile.timezone,
      locale: profile.locale,
      activityFactor: toNumber(profile.activityFactor),
      addExerciseToTarget: profile.addExerciseToTarget,
      soberAssumeUnloggedDry: profile.soberAssumeUnloggedDry,
      newsMail: profile.newsMail,
      requestMail: profile.requestMail,
      theme: themeSchema.catch("system").parse(profile.theme),
      lastDrinkOn: profile.lastDrinkOn,
      /**
       * Null means "use the derived value" (D52). Sent as-is rather than
       * filled in with the derived figure, so the profile form can tell an
       * override from a default without a second flag.
       */
      macroOverrides: {
        proteinG: profile.macroProteinG,
        carbsG: profile.macroCarbsG,
        fatG: profile.macroFatG,
        fiberG: profile.macroFiberG,
      },
    },
  };
}

/**
 * A real argon2id digest of a random string. Verifying against it costs the
 * same as verifying against a real one, which is the entire point: a login for
 * an address that does not exist takes as long as a login for one that does.
 * Computed once, on first use.
 */
let decoy: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(32).toString("hex"));
  return decoy;
}
