// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  createFileStateTracker,
  isDeviceFile,
  BLOCKED_DEVICE_PATHS,
  type FileStateTracker,
} from "./file-state-tracker.js";

describe("FileStateTracker", () => {
  let tracker: FileStateTracker;

  beforeEach(() => {
    tracker = createFileStateTracker();
  });

  describe("BLOCKED_DEVICE_PATHS", () => {
    it("contains all 8 blocked device paths", () => {
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/zero");
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/random");
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/urandom");
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/null");
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/tty");
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/stdin");
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/stdout");
      expect(BLOCKED_DEVICE_PATHS).toContain("/dev/stderr");
      expect(BLOCKED_DEVICE_PATHS.size).toBe(8);
    });
  });

  describe("isDeviceFile", () => {
    it("returns true for each blocked path", () => {
      expect(isDeviceFile("/dev/zero")).toBe(true);
      expect(isDeviceFile("/dev/random")).toBe(true);
      expect(isDeviceFile("/dev/urandom")).toBe(true);
      expect(isDeviceFile("/dev/null")).toBe(true);
      expect(isDeviceFile("/dev/tty")).toBe(true);
      expect(isDeviceFile("/dev/stdin")).toBe(true);
      expect(isDeviceFile("/dev/stdout")).toBe(true);
      expect(isDeviceFile("/dev/stderr")).toBe(true);
    });

    it("returns true for /dev/fd/ paths", () => {
      expect(isDeviceFile("/dev/fd/3")).toBe(true);
      expect(isDeviceFile("/dev/fd/0")).toBe(true);
      expect(isDeviceFile("/dev/fd/255")).toBe(true);
    });

    it("returns false for normal paths", () => {
      expect(isDeviceFile("/home/user/file.txt")).toBe(false);
      expect(isDeviceFile("/tmp/dev/file")).toBe(false);
      expect(isDeviceFile("/workspace/dev/null.txt")).toBe(false);
    });

    it("returns false for /dev directory itself", () => {
      expect(isDeviceFile("/dev")).toBe(false);
      expect(isDeviceFile("/dev/")).toBe(false);
    });
  });

  describe("recordRead + shouldReturnStub", () => {
    it("returns stub string for unchanged file with same offset/limit", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime, 0, 100);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime, 4200, 0, 100);
      expect(result).toBeTypeOf("string");
      expect(result).toContain("unchanged since last read");
    });

    it("returns false when file not previously read", () => {
      const result = tracker.shouldReturnStub("/workspace/file.txt", Date.now(), 1024);
      expect(result).toBe(false);
    });

    it("returns false when mtime changed (file modified)", () => {
      const mtime1 = 1000;
      const mtime2 = 2000;
      tracker.recordRead("/workspace/file.txt", mtime1);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime2, 1024);
      expect(result).toBe(false);
    });

    it("returns false when offset differs from recorded", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime, 0, 100);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime, 1024, 50, 100);
      expect(result).toBe(false);
    });

    it("returns false when limit differs from recorded", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime, 0, 100);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime, 1024, 0, 200);
      expect(result).toBe(false);
    });

    it("returns stub when offset and limit match exactly", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime, 10, 50);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime, 2048, 10, 50);
      expect(result).toBeTypeOf("string");
      expect(result).toContain("unchanged since last read");
    });

    it("returns stub when both calls have no offset/limit", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime, 512);
      expect(result).toBeTypeOf("string");
      expect(result).toContain("unchanged since last read");
    });

    it("includes human-readable size in stub message", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime);

      const stubKB = tracker.shouldReturnStub("/workspace/file.txt", mtime, 4200);
      expect(stubKB).toBeTypeOf("string");
      expect(stubKB).toContain("4.1KB");

      const stubMB = tracker.shouldReturnStub("/workspace/large.txt", mtime, 1_500_000);
      // large.txt not recorded yet -- should return false
      expect(stubMB).toBe(false);
    });

    it("includes ISO date in stub message", () => {
      const mtime = new Date("2026-03-15T12:00:00Z").getTime();
      tracker.recordRead("/workspace/file.txt", mtime);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime, 1024);
      expect(result).toBeTypeOf("string");
      expect(result as string).toContain("2026-03-15");
    });

    it("includes re-read guidance in stub message", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime);
      const result = tracker.shouldReturnStub("/workspace/file.txt", mtime, 1024);
      expect(result).toBeTypeOf("string");
      expect(result as string).toContain("different offset/limit");
    });
  });

  describe("hasBeenRead", () => {
    it("returns false before any read", () => {
      expect(tracker.hasBeenRead("/workspace/file.txt")).toBe(false);
    });

    it("returns true after recordRead", () => {
      tracker.recordRead("/workspace/file.txt", Date.now());
      expect(tracker.hasBeenRead("/workspace/file.txt")).toBe(true);
    });
  });

  describe("getReadState", () => {
    it("returns undefined for unread file", () => {
      expect(tracker.getReadState("/workspace/file.txt")).toBeUndefined();
    });

    it("returns recorded state with mtime and readAt", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime, 10, 50);
      const state = tracker.getReadState("/workspace/file.txt");
      expect(state).toBeDefined();
      expect(state!.mtime).toBe(mtime);
      expect(state!.readAt).toBeTypeOf("number");
      expect(state!.offset).toBe(10);
      expect(state!.limit).toBe(50);
    });
  });

  describe("checkStaleness", () => {
    it("returns stale:false when no read recorded", () => {
      const result = tracker.checkStaleness("/workspace/file.txt", Date.now());
      expect(result).toEqual({ stale: false });
    });

    it("returns stale:false when mtime matches", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime);
      const result = tracker.checkStaleness("/workspace/file.txt", mtime);
      expect(result).toEqual({ stale: false });
    });

    it("returns stale:true with both mtimes when mtime differs", () => {
      const readMtime = 1000;
      const currentMtime = 2000;
      tracker.recordRead("/workspace/file.txt", readMtime);
      const result = tracker.checkStaleness("/workspace/file.txt", currentMtime);
      expect(result).toEqual({
        stale: true,
        readMtime: 1000,
        currentMtime: 2000,
      });
    });
  });

  describe("clone", () => {
    it("creates independent copy -- modifying clone does not affect original", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime);

      const cloned = tracker.clone();

      // Clone should have the same data
      expect(cloned.hasBeenRead("/workspace/file.txt")).toBe(true);

      // Record new read in clone
      cloned.recordRead("/workspace/other.txt", mtime);

      // Original should not be affected
      expect(tracker.hasBeenRead("/workspace/other.txt")).toBe(false);
      expect(cloned.hasBeenRead("/workspace/other.txt")).toBe(true);
    });

    it("preserves full read state in clone", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime, 10, 50);

      const cloned = tracker.clone();
      const state = cloned.getReadState("/workspace/file.txt");
      expect(state).toBeDefined();
      expect(state!.mtime).toBe(mtime);
      expect(state!.offset).toBe(10);
      expect(state!.limit).toBe(50);
    });
  });

  describe("invalidateRead", () => {
    it("removes recorded state so next read is not stubbed", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/file.txt", mtime, 0, 2000);

      // Stub would normally be returned
      expect(tracker.shouldReturnStub("/workspace/file.txt", mtime, 500, 0, 2000)).toBeTypeOf("string");

      tracker.invalidateRead("/workspace/file.txt");

      // After invalidation, stub should not be returned
      expect(tracker.shouldReturnStub("/workspace/file.txt", mtime, 500, 0, 2000)).toBe(false);
      expect(tracker.hasBeenRead("/workspace/file.txt")).toBe(false);
      expect(tracker.getReadState("/workspace/file.txt")).toBeUndefined();
    });

    it("is a no-op for paths that were never read", () => {
      // Should not throw
      tracker.invalidateRead("/workspace/never-read.txt");
      expect(tracker.hasBeenRead("/workspace/never-read.txt")).toBe(false);
    });

    it("does not affect other tracked files", () => {
      const mtime = Date.now();
      tracker.recordRead("/workspace/a.txt", mtime);
      tracker.recordRead("/workspace/b.txt", mtime);

      tracker.invalidateRead("/workspace/a.txt");

      expect(tracker.hasBeenRead("/workspace/a.txt")).toBe(false);
      expect(tracker.hasBeenRead("/workspace/b.txt")).toBe(true);
    });
  });

  describe("content hash staleness fallback", () => {
    it("recordRead stores contentHash for full reads when contentSample provided", () => {
      const content = Buffer.from("hello world");
      tracker.recordRead("/workspace/file.txt", 1000, undefined, undefined, content);
      const state = tracker.getReadState("/workspace/file.txt");
      expect(state).toBeDefined();
      expect(state!.contentHash).toBeDefined();
      expect(state!.contentHash).toBeTypeOf("string");
      expect(state!.contentHash!.length).toBe(64); // SHA-256 hex
    });

    it("recordRead stores contentHash even with offset/limit when contentSample provided", () => {
      const content = Buffer.from("hello world");
      tracker.recordRead("/workspace/file.txt", 1000, 10, 50, content);
      const state = tracker.getReadState("/workspace/file.txt");
      expect(state).toBeDefined();
      // Caller decides when to pass content — hash is stored when provided
      expect(state!.contentHash).toBeDefined();
    });

    it("recordRead does NOT store contentHash when contentSample is not provided", () => {
      tracker.recordRead("/workspace/file.txt", 1000);
      const state = tracker.getReadState("/workspace/file.txt");
      expect(state).toBeDefined();
      expect(state!.contentHash).toBeUndefined();
    });

    it("checkStaleness returns stale:false when mtime differs but contentHash matches", () => {
      const content = Buffer.from("same content");
      tracker.recordRead("/workspace/file.txt", 1000, undefined, undefined, content);
      const result = tracker.checkStaleness("/workspace/file.txt", 2000, content);
      expect(result).toEqual({ stale: false });
    });

    it("checkStaleness returns stale:true when mtime differs and contentHash does NOT match", () => {
      const original = Buffer.from("original content");
      const modified = Buffer.from("modified content");
      tracker.recordRead("/workspace/file.txt", 1000, undefined, undefined, original);
      const result = tracker.checkStaleness("/workspace/file.txt", 2000, modified);
      expect(result).toEqual({ stale: true, readMtime: 1000, currentMtime: 2000 });
    });

    it("checkStaleness updates mtime on hash match to prevent repeated hashing", () => {
      const content = Buffer.from("same content");
      tracker.recordRead("/workspace/file.txt", 1000, undefined, undefined, content);
      // First check -- mtime differs but hash matches
      const result1 = tracker.checkStaleness("/workspace/file.txt", 2000, content);
      expect(result1).toEqual({ stale: false });
      // After hash match, recorded mtime should be updated to 2000
      const state = tracker.getReadState("/workspace/file.txt");
      expect(state!.mtime).toBe(2000);
      // Second check with same mtime should be fast-path (no hash needed)
      const result2 = tracker.checkStaleness("/workspace/file.txt", 2000);
      expect(result2).toEqual({ stale: false });
    });

    it("checkStaleness falls back to mtime-only when no contentHash recorded", () => {
      tracker.recordRead("/workspace/file.txt", 1000);
      const content = Buffer.from("some content");
      const result = tracker.checkStaleness("/workspace/file.txt", 2000, content);
      expect(result).toEqual({ stale: true, readMtime: 1000, currentMtime: 2000 });
    });

    it("checkStaleness falls back to mtime-only when no currentContentSample provided", () => {
      const content = Buffer.from("some content");
      tracker.recordRead("/workspace/file.txt", 1000, undefined, undefined, content);
      // No content sample in checkStaleness -- should still be stale
      const result = tracker.checkStaleness("/workspace/file.txt", 2000);
      expect(result).toEqual({ stale: true, readMtime: 1000, currentMtime: 2000 });
    });

    it("contentHash uses only first 64KB of content", () => {
      // Create buffer larger than 64KB with different data after 64KB
      const buf1 = Buffer.alloc(100_000, 0x41); // 100KB of 'A'
      const buf2 = Buffer.alloc(100_000, 0x41); // Same first 64KB
      buf2.fill(0x42, 65_536); // Different data after 64KB

      tracker.recordRead("/workspace/file1.txt", 1000, undefined, undefined, buf1);
      // checkStaleness with buf2 should match since first 64KB identical
      const result = tracker.checkStaleness("/workspace/file1.txt", 2000, buf2);
      expect(result).toEqual({ stale: false });
    });
  });

  describe("image file tracking", () => {
    it("tracks image files the same as text files (dedup applies)", () => {
      const mtime = Date.now();

      for (const ext of [".jpg", ".png", ".gif", ".webp"]) {
        const path = `/workspace/image${ext}`;
        tracker.recordRead(path, mtime);
        const result = tracker.shouldReturnStub(path, mtime, 2048);
        expect(result).toBeTypeOf("string");
        expect(result).toContain("unchanged since last read");
      }
    });
  });
});
