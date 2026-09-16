/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { Admin } from "../../src/routes/Admin.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * Every admin tab renders the data it is for (D100).
 *
 * Stronger than the smoke tests in `routes.test.tsx`, and deliberately so. Those
 * assert a route is not blank, which is the right bar for a screen whose data
 * path is exercised daily. These screens are the opposite case: they existed as
 * ten endpoints with API tests and **nothing on any screen called them**, and
 * that survived a verification pass because "the admin page renders" was true
 * the whole time.
 *
 * So each test here asserts a value from the stubbed response actually reaches
 * the document: an address, a code, a subject, a logged action. A tab that
 * mounts and shows nothing fails.
 */

const USERS = {
  users: [
    {
      id: "00000000-0000-0000-0000-0000000000aa",
      email: "someone@example.test",
      displayName: "Someone",
      createdAt: "2026-01-05T10:00:00.000Z",
      lastSeenAt: "2026-09-01T08:00:00.000Z",
      disabledAt: null,
      isAdmin: false,
    },
    {
      id: "00000000-0000-0000-0000-0000000000bb",
      email: "disabled@example.test",
      displayName: "Avstängd",
      createdAt: "2026-02-05T10:00:00.000Z",
      lastSeenAt: null,
      disabledAt: "2026-08-01T08:00:00.000Z",
      isAdmin: false,
    },
  ],
};

const INVITES = {
  invites: [
    { code: "AAAA-BBBB", createdAt: "2026-09-01T10:00:00.000Z", usedAt: null, expiresAt: null },
    {
      code: "USED-CODE",
      createdAt: "2026-08-01T10:00:00.000Z",
      usedAt: "2026-08-02T10:00:00.000Z",
      expiresAt: null,
    },
  ],
};

const MAIL = {
  mail: [
    {
      id: "00000000-0000-0000-0000-0000000000c1",
      toAddress: "someone@example.test",
      template: "reset",
      subject: "Återställ ditt lösenord",
      status: "failed",
      attempts: 3,
      lastError: "535 5.7.8 Username and Password not accepted",
      createdAt: "2026-09-05T10:00:00.000Z",
      sentAt: null,
    },
  ],
};

const LOG = {
  entries: [
    {
      id: "00000000-0000-0000-0000-0000000000d1",
      actorEmail: "owner@example.test",
      action: "user.disable",
      subject: "00000000-0000-0000-0000-0000000000aa",
      detail: "someone@example.test",
      createdAt: "2026-09-06T10:00:00.000Z",
    },
  ],
};

/** The requests list is what the shell uses to decide it may be here at all. */
const REQUESTS = {
  requests: [
    {
      id: "00000000-0000-0000-0000-0000000000e1",
      email: "asking@example.test",
      reason: "Vill logga vikt.",
      status: "pending",
      createdAt: "2026-09-04T10:00:00.000Z",
      decidedAt: null,
      inviteCode: null,
    },
  ],
  mailEnabled: true,
};

const MAIL_SETTINGS = {
  settings: {
    host: "smtp.gmail.com",
    port: 587,
    security: "starttls",
    username: "owner@example.test",
    hasPassword: true,
    fromAddress: "owner@example.test",
    fromName: "Vikt",
    updatedAt: "2026-09-06T10:00:00.000Z",
    updatedByEmail: "owner@example.test",
    secretsReadable: true,
  },
  secretKeyPresent: true,
};

const BACKUP = {
  settings: {
    destinationKind: "local",
    destinationPath: "/var/backups/vikt",
    scheduleMinute: 197,
    retainDays: 30,
    updatedAt: "2026-09-06T10:00:00.000Z",
    updatedByEmail: "owner@example.test",
  },
  runs: [
    {
      id: "00000000-0000-0000-0000-0000000000f1",
      startedAt: "2026-09-06T03:17:00.000Z",
      finishedAt: "2026-09-06T03:17:20.000Z",
      status: "failed",
      startedByEmail: null,
      destination: "/var/backups/vikt",
      fileName: null,
      bytes: null,
      error: "pg_dump exited 1: could not connect to server",
    },
  ],
  nextRunAt: "2026-09-07T03:17:00.000Z",
  secretKeyPresent: true,
  downloadable: false,
};

const RESPONSES = [
  // Before the shorter one, because the stub matches on a substring and
  // "/api/admin/mail" is a prefix of "/api/admin/mail-settings".
  { match: "/api/admin/mail-settings", body: MAIL_SETTINGS },
  { match: "/api/admin/backup", body: BACKUP },
  { match: "/api/admin/invite-requests", body: REQUESTS },
  { match: "/api/admin/users", body: USERS },
  { match: "/api/admin/invites", body: INVITES },
  { match: "/api/admin/mail", body: MAIL },
  { match: "/api/admin/log", body: LOG },
  {
    match: "/api/me",
    body: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "owner@example.test",
      displayName: "Owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      isAdmin: true,
      profile: {
        heightCm: 180,
        birthDate: null,
        sex: "unspecified",
        timezone: "Europe/Stockholm",
        locale: "sv-SE",
        activityFactor: 1.35,
        addExerciseToTarget: false,
        soberAssumeUnloggedDry: false,
        lastDrinkOn: null,
        macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
      },
    },
  },
];

const open = (tab: string) =>
  renderRoute(<Admin />, {
    path: tab === "" ? "/admin" : `/admin?vy=${tab}`,
    responses: RESPONSES,
  });

describe("the admin screens", () => {
  afterEach(cleanup);

  it("shows invite requests on the default tab", async () => {
    open("");
    expect(await screen.findByText("asking@example.test")).toBeTruthy();
  });

  it("shows accounts, with created and last seen", async () => {
    open("konton");

    expect(await screen.findByText("someone@example.test")).toBeTruthy();
    expect(screen.getByText("disabled@example.test")).toBeTruthy();

    // The disabled account is marked as such, and the one that has never signed
    // in says so rather than showing an empty date.
    expect(screen.getByText(sv["admin.userDisabled"])).toBeTruthy();
    expect(screen.getByText(/Har aldrig loggat in/)).toBeTruthy();
  });

  it("offers disable, reset and delete per account", async () => {
    open("konton");
    await screen.findByText("someone@example.test");

    expect(screen.getByTestId("toggle-00000000-0000-0000-0000-0000000000aa")).toBeTruthy();
    expect(screen.getByTestId("reset-00000000-0000-0000-0000-0000000000aa")).toBeTruthy();
    expect(screen.getByTestId("delete-user-00000000-0000-0000-0000-0000000000aa")).toBeTruthy();

    // The disabled one offers the way back rather than a second disable.
    expect(screen.getByTestId("toggle-00000000-0000-0000-0000-0000000000bb").textContent).toContain(
      "Slå på igen",
    );
  });

  it("shows invite codes, and offers revoke only for the unused one", async () => {
    open("koder");

    expect(await screen.findByText("AAAA-BBBB")).toBeTruthy();
    expect(screen.getByText("USED-CODE")).toBeTruthy();

    expect(screen.getByTestId("revoke-AAAA-BBBB")).toBeTruthy();
    expect(screen.queryByTestId("revoke-USED-CODE")).toBeNull();
  });

  it("shows the mail queue with its error text and a retry", async () => {
    open("mejl");

    expect(await screen.findByText("Återställ ditt lösenord")).toBeTruthy();
    // §3: a failure is never silent, and the reason is the actionable half.
    expect(screen.getByText(/535 5.7.8/)).toBeTruthy();
    expect(screen.getByTestId("retry-00000000-0000-0000-0000-0000000000c1")).toBeTruthy();
  });

  it("shows the audit log with who did what", async () => {
    open("logg");

    expect(await screen.findByText("owner@example.test")).toBeTruthy();
    expect(screen.getByText(/stängde av kontot/)).toBeTruthy();
    expect(screen.getByText(/someone@example.test/)).toBeTruthy();
  });

  /**
   * The mail server (D102). The assertion that matters is the **absence**: the
   * password is never sent to this screen, so no field can be holding it.
   */
  it("shows the mail server, without ever holding the password", async () => {
    open("mejlserver");

    const host = (await screen.findByLabelText(/Server/)) as HTMLInputElement;
    expect(host.value).toBe("smtp.gmail.com");
    expect((screen.getByLabelText(/Port/) as HTMLInputElement).value).toBe("587");

    // A password is stored, so the field offers to replace it and starts empty.
    const password = screen.getByLabelText(/Nytt lösenord/) as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.type).toBe("password");
    expect(screen.getByTestId("clear-password")).toBeTruthy();

    expect(screen.getByTestId("send-test-mail")).toBeTruthy();
    expect(screen.getByText(/Senast ändrat av owner@example.test/)).toBeTruthy();
  });

  /** The two states that both mean "a password cannot be used" (D102). */
  it("says when there is no key to encrypt a password with", async () => {
    renderRoute(<Admin />, {
      path: "/admin?vy=mejlserver",
      responses: [
        { match: "/api/admin/mail-settings", body: { settings: null, secretKeyPresent: false } },
        ...RESPONSES.filter((r) => r.match !== "/api/admin/mail-settings"),
      ],
    });

    expect(await screen.findByTestId("no-secret-key")).toBeTruthy();
  });

  it("says when a stored password can no longer be read", async () => {
    renderRoute(<Admin />, {
      path: "/admin?vy=mejlserver",
      responses: [
        {
          match: "/api/admin/mail-settings",
          body: {
            settings: { ...MAIL_SETTINGS.settings, secretsReadable: false },
            secretKeyPresent: true,
          },
        },
        ...RESPONSES.filter((r) => r.match !== "/api/admin/mail-settings"),
      ],
    });

    expect(await screen.findByTestId("key-changed")).toBeTruthy();
  });

  /**
   * Backups (D103). The failing run is the interesting case: a status screen
   * that only shows successes is green on the morning the disk filled up.
   */
  it("shows the backup status, including why the last one failed", async () => {
    open("backup");

    expect(await screen.findByTestId("backup-last")).toBeTruthy();
    expect(screen.getByTestId("backup-last").textContent).toContain("Misslyckades");
    expect(screen.getByTestId("backup-error").textContent).toContain("could not connect");

    // The next run, and where it goes.
    expect(screen.getByTestId("backup-next").textContent).toContain("03:17");
    expect(screen.getByText("/var/backups/vikt")).toBeTruthy();

    expect(screen.getByTestId("run-backup")).toBeTruthy();
    // Nothing to download yet, so the link is there and inert rather than absent.
    expect(screen.getByTestId("download-backup").getAttribute("aria-disabled")).toBe("true");
  });

  /**
   * The 404 path (D89). `requireAdmin` answers 404 rather than 403, so this is
   * what a non-admin who reaches the URL is told, and it is all they are told.
   */
  it("says the page does not exist when the API refuses", async () => {
    renderRoute(<Admin />, { path: "/admin", unauthorized: ["/api/admin/"] });

    await waitFor(() =>
      expect(screen.getByText("Den här sidan finns inte.")).toBeTruthy(),
    );
  });
});
