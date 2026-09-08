import { describe, expect, it } from "vitest";
import { registerFormSchema, toRegisterRequest } from "./auth.js";

const valid = {
  inviteCode: "ABCD-EFGH-JKLM-NPQR",
  email: "Someone@Example.test",
  password: "a-long-enough-password",
  confirmPassword: "a-long-enough-password",
  displayName: "Someone",
  timezone: "Europe/Stockholm",
  // Height left the form in D105; consent joined it in D107.
  consent: true as const,
};

describe("the registration form", () => {
  it("accepts a form where both passwords agree", () => {
    const parsed = registerFormSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });


  /**
   * `literal(true)` rather than a boolean (D107). A request that omits consent,
   * or sends false, fails validation rather than registering somebody who never
   * said yes: health data is the one thing that must not be agreed to by
   * implication.
   */
  it("refuses a registration with no consent", () => {
    const { consent, ...withoutConsent } = valid;
    void consent;
    expect(registerFormSchema.safeParse(withoutConsent).success).toBe(false);
    expect(registerFormSchema.safeParse({ ...valid, consent: false }).success).toBe(false);
  });

  it("rejects a mistyped confirmation, and blames the confirmation field", () => {
    const parsed = registerFormSchema.safeParse({
      ...valid,
      confirmPassword: "a-long-enough-passwordd",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues[0];
    expect(issue?.path).toEqual(["confirmPassword"]);
    expect(issue?.message).toBe("The two passwords do not match.");
  });

  it("normalises the invite code and the email the way the server does", () => {
    const parsed = registerFormSchema.parse(valid);
    expect(parsed.inviteCode).toBe("ABCDEFGHJKLMNPQR");
    expect(parsed.email).toBe("someone@example.test");
  });

  it("does not put the confirmation on the wire", () => {
    const request = toRegisterRequest(registerFormSchema.parse(valid));
    expect(request).not.toHaveProperty("confirmPassword");
    expect(request.password).toBe(valid.password);
  });
});
