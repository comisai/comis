// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs", () => ({
  promises: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

const mockSafePath = vi.fn();

vi.mock("@comis/core", () => ({
  safePath: (...args: unknown[]) => mockSafePath(...args),
}));

// Must also mock @comis/shared since profile-decoration imports from it
vi.mock("@comis/shared", () => ({
  ok: (v: unknown) => ({ ok: true, value: v }),
  err: (e: unknown) => ({ ok: false, error: e }),
}));

import { decorateProfile } from "./profile-decoration.js";

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default safePath implementation: just joins paths
  mockSafePath.mockImplementation(
    (base: string, ...segments: string[]) => `${base}/${segments.join("/")}`,
  );
});

// ── Tests ───────────────────────────────────────────────────────────

describe("decorateProfile", () => {
  const profileDir = "/tmp/test-profile";
  const opts = { name: "TestBot", color: "#FF5733" };

  describe("success path", () => {
    it("creates profile directory with mkdir recursive", async () => {
      await decorateProfile(profileDir, opts);

      expect(mockMkdir).toHaveBeenCalledWith(profileDir, { recursive: true });
    });

    it("writes Local State JSON with correct structure", async () => {
      await decorateProfile(profileDir, opts);

      // Find the writeFile call for Local State
      const localStateCall = mockWriteFile.mock.calls.find(
        (call) => (call[0] as string).includes("Local State"),
      );
      expect(localStateCall).toBeDefined();

      const written = JSON.parse(localStateCall![1] as string);
      expect(written.profile.info_cache.Default.name).toBe("TestBot");
      expect(written.profile.info_cache.Default.user_name).toBe("TestBot@comis");
    });

    it("creates Default subdirectory", async () => {
      await decorateProfile(profileDir, opts);

      // Second mkdir call is for the Default directory
      const mkdirCalls = mockMkdir.mock.calls;
      expect(mkdirCalls.length).toBe(2);
      expect(mkdirCalls[1]![0]).toContain("Default");
      expect(mkdirCalls[1]![1]).toEqual({ recursive: true });
    });

    it("writes Default/Preferences JSON with correct structure", async () => {
      await decorateProfile(profileDir, opts);

      // Find the writeFile call for Preferences
      const prefsCall = mockWriteFile.mock.calls.find(
        (call) => (call[0] as string).includes("Preferences"),
      );
      expect(prefsCall).toBeDefined();

      const written = JSON.parse(prefsCall![1] as string);
      expect(written.browser.theme.color).toBe(-1);
      expect(written.ntp.custom_background_dict).toEqual({});
    });

    it("returns ok(undefined) on success", async () => {
      const result = await decorateProfile(profileDir, opts);

      expect(result.ok).toBe(true);
    });

    it("writes files with utf-8 encoding", async () => {
      await decorateProfile(profileDir, opts);

      for (const call of mockWriteFile.mock.calls) {
        expect(call[2]).toBe("utf-8");
      }
    });
  });

  describe("path construction via safePath", () => {
    it("uses safePath for Local State path", async () => {
      await decorateProfile(profileDir, opts);

      expect(mockSafePath).toHaveBeenCalledWith(profileDir, "Local State");
    });

    it("uses safePath for Default directory path", async () => {
      await decorateProfile(profileDir, opts);

      expect(mockSafePath).toHaveBeenCalledWith(profileDir, "Default");
    });

    it("uses safePath for Default/Preferences path", async () => {
      await decorateProfile(profileDir, opts);

      expect(mockSafePath).toHaveBeenCalledWith(profileDir, "Default", "Preferences");
    });
  });

  describe("error handling", () => {
    it("returns err on mkdir failure", async () => {
      const error = new Error("EACCES: permission denied");
      mockMkdir.mockRejectedValueOnce(error);

      const result = await decorateProfile(profileDir, opts);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });

    it("returns err on writeFile failure", async () => {
      const error = new Error("ENOSPC: no space left on device");
      mockWriteFile.mockRejectedValueOnce(error);

      const result = await decorateProfile(profileDir, opts);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("ENOSPC");
      }
    });

    it("wraps non-Error throws in new Error", async () => {
      mockMkdir.mockRejectedValueOnce("string error");

      const result = await decorateProfile(profileDir, opts);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("string error");
      }
    });
  });

  describe("content verification", () => {
    it("Local State user_name follows name@comis format", async () => {
      await decorateProfile(profileDir, { name: "Agent42", color: "#000" });

      const localStateCall = mockWriteFile.mock.calls.find(
        (call) => (call[0] as string).includes("Local State"),
      );
      const written = JSON.parse(localStateCall![1] as string);

      expect(written.profile.info_cache.Default.user_name).toBe("Agent42@comis");
    });

    it("Local State and Preferences are pretty-printed JSON", async () => {
      await decorateProfile(profileDir, opts);

      for (const call of mockWriteFile.mock.calls) {
        const content = call[1] as string;
        // Pretty-printed JSON has newlines and indentation
        expect(content).toContain("\n");
        expect(content).toContain("  ");
      }
    });
  });
});
