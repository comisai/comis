// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for email credential validation.
 *
 * Uses vi.mock() to mock ImapFlow — no real IMAP connections.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// ImapFlow mock
// ---------------------------------------------------------------------------

const mockFns = {
  connect: vi.fn(),
  logout: vi.fn(),
  ctorOptions: [] as Array<Record<string, unknown>>,
};

vi.mock("imapflow", () => {
  return {
    ImapFlow: class MockImapFlow {
      connect: Mock;
      logout: Mock;

      constructor(opts: Record<string, unknown>) {
        mockFns.ctorOptions.push(opts);
        this.connect = mockFns.connect;
        this.logout = mockFns.logout;
      }
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFns.ctorOptions = [];
  mockFns.connect.mockResolvedValue(undefined);
  mockFns.logout.mockResolvedValue(undefined);
});

describe("validateEmailCredentials", () => {
  async function getValidator() {
    return import("./credential-validator.js");
  }

  it("returns ok with user info on successful connection", async () => {
    const { validateEmailCredentials } = await getValidator();
    const result = await validateEmailCredentials({
      imapHost: "imap.example.com",
      imapPort: 993,
      secure: true,
      auth: { user: "user@example.com", pass: "test-pass" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.user).toBe("user@example.com");
    }
    expect(mockFns.connect).toHaveBeenCalled();
    expect(mockFns.logout).toHaveBeenCalled();
  });

  it("returns err on connection failure", async () => {
    mockFns.connect.mockRejectedValue(new Error("Connection refused"));

    const { validateEmailCredentials } = await getValidator();
    const result = await validateEmailCredentials({
      imapHost: "bad-host.example.com",
      imapPort: 993,
      secure: true,
      auth: { user: "user@example.com", pass: "wrong-pass" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Connection refused");
    }
  });

  it("passes proxy to ImapFlow when proxyUrl is set, and omits it otherwise", async () => {
    const { validateEmailCredentials } = await getValidator();
    await validateEmailCredentials({
      imapHost: "imap.example.com",
      imapPort: 993,
      secure: true,
      auth: { user: "user@example.com", pass: "p" },
      proxyUrl: "http://proxy.corp:3128",
    });
    expect(mockFns.ctorOptions[0]).toMatchObject({ proxy: "http://proxy.corp:3128" });

    mockFns.ctorOptions = [];
    await validateEmailCredentials({
      imapHost: "imap.example.com",
      imapPort: 993,
      secure: true,
      auth: { user: "user@example.com", pass: "p" },
    });
    expect(mockFns.ctorOptions[0]).not.toHaveProperty("proxy");
  });

  it("classifies an unreachable IMAP host as a network failure (CredentialValidationError.kind)", async () => {
    const { CredentialValidationError } = await import("../shared/credential-validation-error.js");
    mockFns.connect.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4:993"));

    const { validateEmailCredentials } = await getValidator();
    const result = await validateEmailCredentials({
      imapHost: "imap.example.com",
      imapPort: 993,
      secure: true,
      auth: { user: "user@example.com", pass: "p" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CredentialValidationError);
      expect((result.error as InstanceType<typeof CredentialValidationError>).kind).toBe("network");
    }
  });
});
