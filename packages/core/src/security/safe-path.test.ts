import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { safePath, PathTraversalError } from "./safe-path.js";

describe("safePath", () => {
  describe("valid paths (should succeed)", () => {
    it("resolves a simple filename within base", () => {
      expect(safePath("/base", "file.txt")).toBe("/base/file.txt");
    });

    it("resolves multiple segments within base", () => {
      expect(safePath("/base", "subdir", "file.txt")).toBe("/base/subdir/file.txt");
    });

    it("returns base directory itself when no segments given", () => {
      expect(safePath("/base")).toBe("/base");
    });

    it("resolves nested path segments with slashes", () => {
      expect(safePath("/base", "a/b/c")).toBe("/base/a/b/c");
    });
  });

  describe("path traversal attacks (should throw PathTraversalError)", () => {
    it("rejects bare ..", () => {
      expect(() => safePath("/base", "..")).toThrow(PathTraversalError);
    });

    it("rejects ../../etc/passwd", () => {
      expect(() => safePath("/base", "../../etc/passwd")).toThrow(PathTraversalError);
    });

    it("rejects subdir/../../../etc/passwd", () => {
      expect(() => safePath("/base", "subdir/../../../etc/passwd")).toThrow(PathTraversalError);
    });
  });

  describe("URL-encoded attacks (should throw)", () => {
    it("rejects %2e%2e%2f (encoded ../)", () => {
      expect(() => safePath("/base", "%2e%2e%2fetc/passwd")).toThrow(PathTraversalError);
    });

    it("rejects %2e%2e/ (encoded ../) ", () => {
      expect(() => safePath("/base", "%2e%2e/etc/passwd")).toThrow(PathTraversalError);
    });
  });

  describe("prefix attacks (should throw)", () => {
    it("rejects ../uploads-evil/file when base is /uploads", () => {
      expect(() => safePath("/uploads", "../uploads-evil/file")).toThrow(PathTraversalError);
    });
  });

  describe("symlink attacks (integration test)", () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects symlinks pointing outside base", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "safepath-test-"));
      const baseDir = path.join(tmpDir, "base");
      const outsideDir = path.join(tmpDir, "outside");
      fs.mkdirSync(baseDir);
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");

      // Create symlink inside base pointing to outside
      const symlinkPath = path.join(baseDir, "evil-link");
      fs.symlinkSync(outsideDir, symlinkPath);

      expect(() => safePath(baseDir, "evil-link", "secret.txt")).toThrow(PathTraversalError);
    });
  });

  describe("null byte attacks (should throw)", () => {
    it("rejects paths containing null bytes", () => {
      expect(() => safePath("/base", "file\0.txt")).toThrow(PathTraversalError);
    });
  });

  describe("PathTraversalError properties", () => {
    it("has name 'PathTraversalError'", () => {
      try {
        safePath("/base", "../../etc/passwd");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PathTraversalError);
        expect((error as PathTraversalError).name).toBe("PathTraversalError");
      }
    });

    it("includes base and attempted properties", () => {
      try {
        safePath("/base", "../../etc/passwd");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PathTraversalError);
        const pte = error as PathTraversalError;
        expect(pte.base).toBe("/base");
        expect(pte.attempted).toBeDefined();
        expect(typeof pte.attempted).toBe("string");
      }
    });
  });
});
