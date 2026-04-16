import { describe, it, expect, vi, afterEach } from "vitest";
import { validateIMessageConnection } from "./credential-validator.js";

// We need to mock process.platform and child_process for testing
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
const mockExecFile = vi.mocked(execFile);

describe("validateIMessageConnection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("platform check", () => {
    it("rejects non-macOS platforms with clear error", async () => {
      // Save original and override
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const result = await validateIMessageConnection();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("iMessage adapter requires macOS");
          expect(result.error.message).toContain("linux");
        }
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("rejects Windows platform", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      try {
        const result = await validateIMessageConnection();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("iMessage adapter requires macOS");
          expect(result.error.message).toContain("win32");
        }
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("passes platform check on macOS", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      // Mock which to fail (we just want to verify platform passes)
      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, callback: unknown) => {
          (callback as (err: Error | null, stdout: string) => void)(
            new Error("not found"),
            "",
          );
          return undefined as unknown as ReturnType<typeof execFile>;
        },
      );

      try {
        const result = await validateIMessageConnection();
        // Should fail at binary check, NOT platform check
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("imsg binary not found");
          expect(result.error.message).not.toContain("requires macOS");
        }
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });

  describe("binary validation", () => {
    it("reports missing binary with install instructions", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, callback: unknown) => {
          (callback as (err: Error | null, stdout: string) => void)(
            new Error("not found"),
            "",
          );
          return undefined as unknown as ReturnType<typeof execFile>;
        },
      );

      try {
        const result = await validateIMessageConnection();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("imsg binary not found");
        }
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("uses custom binary path when provided", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, callback: unknown) => {
          (callback as (err: Error | null, stdout: string) => void)(
            new Error("not found"),
            "",
          );
          return undefined as unknown as ReturnType<typeof execFile>;
        },
      );

      try {
        const result = await validateIMessageConnection({
          binaryPath: "/custom/path/imsg",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("/custom/path/imsg");
        }
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("succeeds when binary found and rpc probe passes", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      let callCount = 0;
      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, callback: unknown) => {
          callCount++;
          if (callCount === 1) {
            // which call - binary found
            (callback as (err: Error | null, stdout: string) => void)(
              null,
              "/usr/local/bin/imsg\n",
            );
          } else {
            // rpc --help call - success
            (callback as (err: Error | null, stdout: string, stderr: string) => void)(
              null,
              "imsg rpc - Start JSON-RPC server",
              "",
            );
          }
          return undefined as unknown as ReturnType<typeof execFile>;
        },
      );

      try {
        const result = await validateIMessageConnection();
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.platform).toBe("macos");
          expect(result.value.available).toBe(true);
        }
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });
});
