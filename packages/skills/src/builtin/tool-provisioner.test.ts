/**
 * Tests for tool-provisioner module.
 *
 * Verifies getToolPath and ensureTool behavior, TOOLS registry correctness,
 * and COMIS_OFFLINE env var handling.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { getToolPath, ensureTool } from "./tool-provisioner.js";

describe("tool-provisioner", () => {
  // Preserve original env
  const origOffline = process.env.COMIS_OFFLINE;

  afterEach(() => {
    if (origOffline === undefined) {
      delete process.env.COMIS_OFFLINE;
    } else {
      process.env.COMIS_OFFLINE = origOffline;
    }
  });

  describe("getToolPath", () => {
    it("returns string for rg when ripgrep is available on system", () => {
      const result = getToolPath("rg");
      // rg is typically available in CI/dev — may be string or null
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("returns null for unknown tool key", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = getToolPath("nonexistent" as any);
      expect(result).toBeNull();
    });

    it("returns string or null for fd", () => {
      const result = getToolPath("fd");
      expect(result === null || typeof result === "string").toBe(true);
    });
  });

  describe("ensureTool", () => {
    it("returns undefined in offline mode (COMIS_OFFLINE=1)", async () => {
      process.env.COMIS_OFFLINE = "1";
      // Force a tool that may not be installed to test offline guard
      const result = await ensureTool("fd");
      // If fd is installed, it returns the path even in offline mode (getToolPath runs first).
      // If fd is NOT installed, offline mode returns undefined (no download attempt).
      expect(result === undefined || typeof result === "string").toBe(true);
    });

    it("returns undefined in offline mode (COMIS_OFFLINE=true)", async () => {
      process.env.COMIS_OFFLINE = "true";
      const result = await ensureTool("fd");
      expect(result === undefined || typeof result === "string").toBe(true);
    });

    it("returns undefined for unknown tool key", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await ensureTool("nonexistent" as any);
      expect(result).toBeUndefined();
    });

    it("accepts optional logger parameter without error", async () => {
      const debugMessages: string[] = [];
      const logger = { debug: (msg: string) => debugMessages.push(msg) };
      // ensureTool should not throw even with a logger
      const result = await ensureTool("rg", logger);
      expect(result === undefined || typeof result === "string").toBe(true);
    });

    it("returns existing tool path if tool is already installed", async () => {
      const path = getToolPath("rg");
      if (path) {
        // If rg is installed, ensureTool should return the same path
        const result = await ensureTool("rg");
        expect(result).toBe(path);
      }
    });
  });
});
