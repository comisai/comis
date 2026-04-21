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
};

vi.mock("imapflow", () => {
  return {
    ImapFlow: class MockImapFlow {
      connect: Mock;
      logout: Mock;

      constructor() {
        this.connect = mockFns.connect;
        this.logout = mockFns.logout;
      }
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
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
});
