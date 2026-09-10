/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { Backup } from "../../src/routes/admin/Backup.js";

/**
 * Configuring a share from the admin screen (D130).
 *
 * The password is the whole reason this test exists. The screen never receives
 * it, so an empty box has to mean "leave the stored one alone" rather than
 * "clear it" — otherwise the password would be wiped every time somebody
 * changed the retention window, and it would be wiped silently, and the next
 * scheduled run at three in the morning would be the thing that found out.
 */

function loaded(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      destinationKind: "smb",
      destinationPath: "vikt",
      scheduleMinute: 180,
      retainDays: 30,
      smbHost: "nas.example.test",
      smbShare: "backup",
      smbDomain: "",
      smbUsername: "vikt",
      smbPasswordSet: true,
      updatedAt: "2026-09-10T00:00:00.000Z",
      updatedByEmail: "admin@example.test",
      ...overrides,
    },
    runs: [],
    nextRunAt: null,
    secretKeyPresent: true,
    downloadable: false,
  };
}

/** Captures what the screen would send, which is what these are about. */
function mount(body: ReturnType<typeof loaded> = loaded()) {
  const saved: unknown[] = [];
  const tested: unknown[] = [];

  renderRoute(<Backup />, {
    stateful: [
      /**
       * The more specific path first: `find` takes the first match, and
       * "/api/admin/backup" is a prefix of "/api/admin/backup/test".
       */
      {
        match: "/api/admin/backup/test",
        get: () => ({}),
        post: (sent) => tested.push(sent),
        wrote: { ok: true, wrote: "vikt-probe-1.tmp", reason: null },
      },
      {
        match: "/api/admin/backup",
        get: () => body,
        post: (sent) => saved.push(sent),
        wrote: { ok: true },
      },
    ],
  });

  return { saved, tested };
}

describe("the backup destination", () => {
  afterEach(cleanup);

  it("shows the share fields for a share and the path field for a directory", async () => {
    mount();
    await screen.findByTestId("backup-smb-fields");

    expect((screen.getByTestId("backup-kind") as HTMLSelectElement).value).toBe("smb");
    expect((screen.getByLabelText(/Server/) as HTMLInputElement).value).toBe("nas.example.test");

    // Switching back puts the plain path field there instead.
    fireEvent.change(screen.getByTestId("backup-kind"), { target: { value: "local" } });
    expect(screen.queryByTestId("backup-smb-fields")).toBeNull();
  });

  /** Never prefilled, because it never arrives. */
  it("does not prefill the password", async () => {
    mount();
    const field = (await screen.findByTestId("backup-smb-password")) as HTMLInputElement;

    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    // But it says one is stored, so an empty box is not read as "none set".
    expect(screen.getByText(/Ett lösenord är sparat/)).toBeTruthy();
  });

  /**
   * The case that would otherwise wipe a password: saving something else.
   * An untouched password field must send no password key at all.
   */
  it("omits the password entirely when it was not typed", async () => {
    const { saved } = mount();
    await screen.findByTestId("backup-smb-fields");

    fireEvent.click(screen.getByTestId("save-backup"));
    await waitFor(() => expect(saved).toHaveLength(1));

    const body = saved[0] as Record<string, unknown>;
    expect(body.destinationKind).toBe("smb");
    expect(body.smbHost).toBe("nas.example.test");
    expect("smbPassword" in body).toBe(false);
  });

  it("sends a typed password", async () => {
    const { saved } = mount();
    await screen.findByTestId("backup-smb-fields");

    fireEvent.change(screen.getByTestId("backup-smb-password"), {
      target: { value: "nytt-lösenord" },
    });
    fireEvent.click(screen.getByTestId("save-backup"));
    await waitFor(() => expect(saved).toHaveLength(1));

    expect((saved[0] as Record<string, unknown>).smbPassword).toBe("nytt-lösenord");
  });

  /** Clearing is its own control: one empty box cannot mean two things. */
  it("sends an explicit empty password only when clearing is asked for", async () => {
    const { saved } = mount();
    await screen.findByTestId("backup-smb-fields");

    fireEvent.click(screen.getByTestId("backup-smb-clear"));
    fireEvent.click(screen.getByTestId("save-backup"));
    await waitFor(() => expect(saved).toHaveLength(1));

    expect((saved[0] as Record<string, unknown>).smbPassword).toBe("");
  });

  /** And there is nothing to clear when nothing is stored. */
  it("offers no clear control when no password is stored", async () => {
    mount(loaded({ smbPasswordSet: false }));
    await screen.findByTestId("backup-smb-fields");

    expect(screen.queryByTestId("backup-smb-clear")).toBeNull();
  });

  /**
   * It tests what is saved rather than what is typed, so it sends no body at
   * all: a probe against unsaved values would pass and the schedule would then
   * run against the old ones.
   */
  it("has a test button that reaches the test endpoint alone", async () => {
    const { saved, tested } = mount();
    await screen.findByTestId("backup-smb-fields");

    fireEvent.click(screen.getByTestId("test-backup"));
    await waitFor(() => expect(tested).toHaveLength(1));

    expect(saved).toHaveLength(0);
    expect(await screen.findByTestId("backup-notice")).toBeTruthy();
  });
});
