import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMediaStore } from "./media-store.js";
import type { MediaStore } from "./media-store.js";

let tmpDir: string;
let store: MediaStore;

function mockLogger() {
  return { warn: vi.fn() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(`${os.tmpdir()}/comis-media-test-`);
  store = createMediaStore({
    mediaDir: tmpDir,
    logger: mockLogger(),
  });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("save", () => {
  it("returns SavedMedia with UUID id and file exists on disk", async () => {
    const buf = Buffer.from("hello media");
    const result = await store.save(buf, "text/plain");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.value.size).toBe(buf.length);
    expect(result.value.contentType).toBe("text/plain");
    expect(result.value.savedAt).toBeGreaterThan(0);

    // File should exist on disk
    const fileStat = await fsp.stat(result.value.path);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.size).toBe(buf.length);

    // Meta sidecar should exist
    const metaRaw = await fsp.readFile(`${result.value.path}.meta`, "utf-8");
    const meta = JSON.parse(metaRaw);
    expect(meta.contentType).toBe("text/plain");
    expect(meta.size).toBe(buf.length);
  });

  it("rejects files exceeding maxBytes", async () => {
    const smallStore = createMediaStore({
      mediaDir: tmpDir,
      maxBytes: 10,
      logger: mockLogger(),
    });

    const buf = Buffer.alloc(50);
    const result = await smallStore.save(buf);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("exceeds max size");
  });

  it("saves to subdirectory when specified", async () => {
    const buf = Buffer.from("sub");
    const result = await store.save(buf, "text/plain", "images");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.path).toContain("images");
    const stat = await fsp.stat(result.value.path);
    expect(stat.isFile()).toBe(true);
  });
});

describe("get", () => {
  it("retrieves saved file with correct content", async () => {
    const content = Buffer.from("test-content-12345");
    const saved = await store.save(content, "image/png");
    if (!saved.ok) throw new Error("save failed");

    const result = await store.get(saved.value.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buffer.toString()).toBe("test-content-12345");
    expect(result.value.contentType).toBe("image/png");
    expect(result.value.savedAt).toBeGreaterThan(0);
  });

  it("returns err for nonexistent ID", async () => {
    const result = await store.get("00000000-0000-0000-0000-000000000000");

    expect(result.ok).toBe(false);
  });

  it("rejects invalid media IDs", async () => {
    // Path traversal attempt
    const result = await store.get("../../../etc/passwd");
    expect(result.ok).toBe(false);

    // Empty
    const emptyResult = await store.get("");
    expect(emptyResult.ok).toBe(false);

    // Dot only
    const dotResult = await store.get("..");
    expect(dotResult.ok).toBe(false);
  });
});

describe("cleanup", () => {
  it("removes files older than TTL", async () => {
    const buf = Buffer.from("old-file");
    const saved = await store.save(buf);
    if (!saved.ok) throw new Error("save failed");

    // Wait a small amount so the file has a non-zero age
    await new Promise((r) => setTimeout(r, 50));

    // Use a very small TTL so the file is "expired"
    const result = await store.cleanup(1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeGreaterThanOrEqual(1);

    // File should be gone
    const getResult = await store.get(saved.value.id);
    expect(getResult.ok).toBe(false);
  });

  it("preserves files newer than TTL", async () => {
    const buf = Buffer.from("fresh-file");
    const saved = await store.save(buf);
    if (!saved.ok) throw new Error("save failed");

    // Use a very large TTL so the file is "fresh"
    const result = await store.cleanup(999_999_999);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);

    // File should still exist
    const getResult = await store.get(saved.value.id);
    expect(getResult.ok).toBe(true);
  });

  it("returns 0 when directory does not exist", async () => {
    const emptyStore = createMediaStore({
      mediaDir: `${tmpDir}/nonexistent`,
      logger: mockLogger(),
    });

    const result = await emptyStore.cleanup();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);
  });
});

describe("delete", () => {
  it("removes file and .meta sidecar", async () => {
    const buf = Buffer.from("delete-me");
    const saved = await store.save(buf, "text/plain");
    if (!saved.ok) throw new Error("save failed");

    const deleteResult = await store.delete(saved.value.id);
    expect(deleteResult.ok).toBe(true);

    // Both file and meta should be gone
    const getResult = await store.get(saved.value.id);
    expect(getResult.ok).toBe(false);
  });

  it("rejects invalid IDs", async () => {
    const result = await store.delete("../../etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("succeeds silently for nonexistent files", async () => {
    const result = await store.delete("nonexistent-id-12345");
    expect(result.ok).toBe(true);
  });
});
