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

  it("secret mode still requires appPassword when authMode is set explicitly", () => {
    const result = validateMsTeamsCredentials({
      authMode: "secret",
      appId: "app-id",
      tenantId: "tenant-id",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("appPassword");
  });

  it("certificate mode validates ok with appId + certPath + tenantId and no appPassword", () => {
    const result = validateMsTeamsCredentials({
      authMode: "certificate",
      appId: "app-id",
      tenantId: "tenant-id",
      certPath: "/etc/comis/teams-cert.pem",
    });
    expect(result.ok).toBe(true);
  });

  it("certificate mode errs naming certPath when the certificate path is missing", () => {
    const result = validateMsTeamsCredentials({
      authMode: "certificate",
      appId: "app-id",
      tenantId: "tenant-id",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("certPath");
  });

  it("managed-identity mode validates ok with appId + managedIdentityClientId + tenantId", () => {
    const result = validateMsTeamsCredentials({
      authMode: "managedIdentity",
      appId: "app-id",
      tenantId: "tenant-id",
      managedIdentityClientId: "mi-client-id",
    });
    expect(result.ok).toBe(true);
  });

  it("managed-identity mode errs naming managedIdentityClientId when it is missing", () => {
    const result = validateMsTeamsCredentials({
      authMode: "managedIdentity",
      appId: "app-id",
      tenantId: "tenant-id",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("managedIdentityClientId");
  });
});
