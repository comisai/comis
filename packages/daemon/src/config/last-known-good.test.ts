// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  lastKnownGoodPath,
  saveLastKnownGood,
  restoreLastKnownGood,
  buildRollbackSuggestion,
  handleRestoreFlag,
} from "./last-known-good.js";

describe("last-known-good config", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lkg-test-"));
    configPath = join(tmpDir, "config.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("lastKnownGoodPath", () => {
    it("derives .last-good.yaml from config path", () => {
      expect(lastKnownGoodPath("/home/user/.comis/config.yaml")).toBe(
        "/home/user/.comis/config.last-good.yaml",
      );
    });

    it("handles config.local.yaml", () => {
      expect(lastKnownGoodPath("/home/user/.comis/config.local.yaml")).toBe(
        "/home/user/.comis/config.local.last-good.yaml",
      );
    });
  });

  describe("saveLastKnownGood", () => {
    it("copies config to last-known-good path", () => {
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path, "utf-8")).toBe("key: value\n");
    });

    it("returns saved: false when config does not exist", () => {
      const result = saveLastKnownGood(join(tmpDir, "nonexistent.yaml"));
      expect(result.saved).toBe(false);
    });

    it("sets 0o600 permissions on snapshot file", () => {
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);

      const stat = statSync(result.path);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("overwrites existing last-known-good", () => {
      writeFileSync(configPath, "version: 1\n");
      saveLastKnownGood(configPath);

      writeFileSync(configPath, "version: 2\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);
      expect(readFileSync(result.path, "utf-8")).toBe("version: 2\n");
    });
  });

  describe("restoreLastKnownGood", () => {
    it("restores config from last-known-good", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);

      // Simulate bad config change
      writeFileSync(configPath, "bad: true\n");
      expect(readFileSync(configPath, "utf-8")).toBe("bad: true\n");

      const result = restoreLastKnownGood(configPath);
      expect(result.restored).toBe(true);
      expect(readFileSync(configPath, "utf-8")).toBe("good: true\n");
    });

    it("sets 0o600 permissions on restored config file", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);

      // Overwrite config with bad content (and default permissive permissions)
      writeFileSync(configPath, "bad: true\n");

      const result = restoreLastKnownGood(configPath);
      expect(result.restored).toBe(true);

      const stat = statSync(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("returns restored: false when no snapshot exists", () => {
      writeFileSync(configPath, "key: value\n");
      const result = restoreLastKnownGood(configPath);
      expect(result.restored).toBe(false);
    });
  });

  describe("buildRollbackSuggestion", () => {
    it("returns null when no last-known-good exists", () => {
      writeFileSync(configPath, "key: value\n");
      expect(buildRollbackSuggestion(configPath)).toBeNull();
    });

    it("returns hint and diff when last-known-good exists and differs", () => {
      writeFileSync(configPath, "key: good\n");
      saveLastKnownGood(configPath);
      writeFileSync(configPath, "key: bad\n");

      const result = buildRollbackSuggestion(configPath);
      expect(result).not.toBeNull();
      expect(result!.hint).toContain("--restore-last-good");
      expect(result!.diff).toContain("- key: good");
      expect(result!.diff).toContain("+ key: bad");
    });

    it("notes when configs are identical", () => {
      writeFileSync(configPath, "key: value\n");
      saveLastKnownGood(configPath);

      const result = buildRollbackSuggestion(configPath);
      expect(result).not.toBeNull();
      expect(result!.diff).toContain("no differences");
    });
  });

  describe("handleRestoreFlag", () => {
    it("restores and exits 0 when snapshot exists", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);
      writeFileSync(configPath, "bad: true\n");

      let exitCode = -1;
      handleRestoreFlag([configPath], (code) => { exitCode = code; });
      expect(exitCode).toBe(0);
      expect(readFileSync(configPath, "utf-8")).toBe("good: true\n");
    });

    it("exits 1 when no snapshot exists", () => {
      writeFileSync(configPath, "key: value\n");
      let exitCode = -1;
      handleRestoreFlag([configPath], (code) => { exitCode = code; });
      expect(exitCode).toBe(1);
    });

    it("exits 1 when no config paths provided", () => {
      let exitCode = -1;
      handleRestoreFlag([], (code) => { exitCode = code; });
      expect(exitCode).toBe(1);
    });
  });
});
