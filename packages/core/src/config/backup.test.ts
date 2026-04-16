import { describe, it, expect } from "vitest";
import { ok, err } from "@comis/shared";
import type { ConfigError } from "./types.js";
import { createTimestampedBackup } from "./backup.js";
import type { BackupDeps } from "./backup.js";

/**
 * Helper to build mock BackupDeps with a virtual filesystem.
 */
function createMockDeps(
  files: Set<string>,
  opts?: {
    copyFail?: boolean;
    listDirFail?: boolean;
    removeFail?: boolean;
    dirContents?: string[];
  },
): BackupDeps & { removed: string[] } {
  const removed: string[] = [];

  return {
    removed,
    copyFile(src: string, dest: string) {
      if (opts?.copyFail) {
        return err({
          code: "BACKUP_ERROR" as const,
          message: `Permission denied: ${dest}`,
        } as ConfigError);
      }
      files.add(dest);
      return ok(undefined);
    },
    listDir(dirPath: string) {
      if (opts?.listDirFail) {
        return err({
          code: "BACKUP_ERROR" as const,
          message: `Cannot list directory: ${dirPath}`,
        } as ConfigError);
      }
      const contents = opts?.dirContents ?? [...files].map((f) => {
        const parts = f.split("/");
        return parts[parts.length - 1];
      });
      return ok(contents);
    },
    removeFile(filePath: string) {
      if (opts?.removeFail) {
        return err({
          code: "BACKUP_ERROR" as const,
          message: `Cannot remove: ${filePath}`,
        } as ConfigError);
      }
      removed.push(filePath);
      files.delete(filePath);
      return ok(undefined);
    },
    fileExists(filePath: string) {
      return files.has(filePath);
    },
    now() {
      return new Date("2026-02-12T14:30:00Z");
    },
  };
}

describe("config/backup", () => {
  describe("createTimestampedBackup", () => {
    it("copies source file to backup path with ISO timestamp", () => {
      const files = new Set(["/config/app.yaml"]);
      const deps = createMockDeps(files);

      const result = createTimestampedBackup("/config/app.yaml", deps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("/config/app.yaml.backup.20260212T143000Z");
        expect(files.has("/config/app.yaml.backup.20260212T143000Z")).toBe(true);
      }
    });

    it("uses compact ISO format without colons (filesystem-safe)", () => {
      const files = new Set(["/config/app.yaml"]);
      const deps = createMockDeps(files);

      const result = createTimestampedBackup("/config/app.yaml", deps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // No colons, dashes only in date part
        expect(result.value).toMatch(/\.backup\.\d{8}T\d{6}Z$/);
      }
    });

    it("returns Result with the backup file path on success", () => {
      const files = new Set(["/config/app.yaml"]);
      const deps = createMockDeps(files);

      const result = createTimestampedBackup("/config/app.yaml", deps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe("string");
        expect(result.value).toContain("app.yaml.backup.");
      }
    });

    it("returns ConfigError when source file does not exist", () => {
      const files = new Set<string>();
      const deps = createMockDeps(files);

      const result = createTimestampedBackup("/config/missing.yaml", deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BACKUP_ERROR");
        expect(result.error.message).toContain("missing.yaml");
      }
    });

    it("returns ConfigError when copy fails (e.g., permissions)", () => {
      const files = new Set(["/config/app.yaml"]);
      const deps = createMockDeps(files, { copyFail: true });

      const result = createTimestampedBackup("/config/app.yaml", deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BACKUP_ERROR");
        expect(result.error.message).toContain("Permission denied");
      }
    });

    it("deletes oldest backups when count exceeds maxBackups (default 10)", () => {
      const files = new Set(["/config/app.yaml"]);
      // Simulate 10 existing backups + the new one that will be created
      const dirContents: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ts = `202602${String(i + 1).padStart(2, "0")}T120000Z`;
        dirContents.push(`app.yaml.backup.${ts}`);
      }
      // The new backup created by the function (injected clock = 2026-02-12T14:30:00Z)
      dirContents.push("app.yaml.backup.20260212T143000Z");
      const deps = createMockDeps(files, { dirContents });

      const result = createTimestampedBackup("/config/app.yaml", deps);

      expect(result.ok).toBe(true);
      // 10 existing + 1 new = 11, should prune oldest 1
      expect(deps.removed.length).toBe(1);
      expect(deps.removed[0]).toContain("app.yaml.backup.20260201T120000Z");
    });

    it("only deletes files matching the backup naming pattern", () => {
      const files = new Set(["/config/app.yaml"]);
      const dirContents = [
        "app.yaml.backup.20260201T120000Z",
        "app.yaml.backup.20260202T120000Z",
        "app.yaml", // Not a backup file
        "other-file.txt", // Not a backup file
        "app.yaml.backup.20260203T120000Z",
        "app.yaml.backup.20260212T143000Z", // New backup from this call
      ];
      // 3 existing + 1 new = 4 backups, well under default 10
      const deps = createMockDeps(files, { dirContents });

      const result = createTimestampedBackup("/config/app.yaml", deps);

      expect(result.ok).toBe(true);
      // No backups should be deleted (only 4 backups, well under 10)
      expect(deps.removed.length).toBe(0);
    });

    it("maxBackups is configurable via options parameter", () => {
      const files = new Set(["/config/app.yaml"]);
      const dirContents: string[] = [];
      for (let i = 0; i < 5; i++) {
        const ts = `202602${String(i + 1).padStart(2, "0")}T120000Z`;
        dirContents.push(`app.yaml.backup.${ts}`);
      }
      // The new backup created by the function (injected clock = 2026-02-12T14:30:00Z)
      dirContents.push("app.yaml.backup.20260212T143000Z");
      const deps = createMockDeps(files, { dirContents });

      const result = createTimestampedBackup("/config/app.yaml", deps, {
        maxBackups: 3,
      });

      expect(result.ok).toBe(true);
      // 5 existing + 1 new = 6, maxBackups=3 → prune 3 oldest
      expect(deps.removed.length).toBe(3);
      expect(deps.removed[0]).toContain("20260201T120000Z");
      expect(deps.removed[1]).toContain("20260202T120000Z");
      expect(deps.removed[2]).toContain("20260203T120000Z");
    });
  });
});
