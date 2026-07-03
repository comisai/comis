// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateMsTeamsCredentials } from "../credential-validator.js";

const VALID = { appId: "app-id", appPassword: "app-secret", tenantId: "tenant-id" };

describe("validateMsTeamsCredentials", () => {
  it("returns ok when appId, appPassword and tenantId are all present", () => {
    const result = validateMsTeamsCredentials({ ...VALID });
    expect(result.ok).toBe(true);
  });

  it("returns err naming appId when appId is empty", () => {
    const result = validateMsTeamsCredentials({ ...VALID, appId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("appId");
  });

  it("returns err naming appPassword when appPassword is missing", () => {
    const result = validateMsTeamsCredentials({ ...VALID, appPassword: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("appPassword");
  });

  it("returns err naming tenantId when tenantId is blank", () => {
    const result = validateMsTeamsCredentials({ ...VALID, tenantId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("tenantId");
  });

  it("treats whitespace-only credentials as empty and errs", () => {
    const result = validateMsTeamsCredentials({ ...VALID, appId: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("appId");
  });

  it("never includes the supplied app-password value in the error message", () => {
    const secret = "super-secret-pw";
    const result = validateMsTeamsCredentials({ appId: "", appPassword: secret, tenantId: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(secret);
  });

  it("returns err when the options object is entirely empty", () => {
    const result = validateMsTeamsCredentials({});
    expect(result.ok).toBe(false);
  });
});
