// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect } from "vitest";

import {
  getQueuedFileWriter,
  type QueuedFileWriter,
} from "./queued-file-writer.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("getQueuedFileWriter — LRU dedup by path", () => {
  it("returns the same QueuedFileWriter instance for two calls with the same path", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-dedup-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "logs", "out.jsonl");

    const a = getQueuedFileWriter(writers, target);
    const b = getQueuedFileWriter(writers, target);
    expect(a).toBe(b);
  });

  it("returns different writers for different paths", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-distinct-"));
    const writers = new Map<string, QueuedFileWriter>();

    const a = getQueuedFileWriter(writers, path.join(tmpDir, "a.jsonl"));
    const b = getQueuedFileWriter(writers, path.join(tmpDir, "b.jsonl"));
    expect(a).not.toBe(b);
  });
});

describe("QueuedFileWriter.write — happy path, parent dir created with mode 0o700", () => {
  it("writes a line to disk after the queued promise chain resolves", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-write-"));
    const writers = new Map<string, QueuedFileWriter>();
    const dir = path.join(tmpDir, "logs");
    const target = path.join(dir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    const status = w.write("hello\n");
    expect(status).toBe("queued");

    await w.flush();

    expect(fs.readFileSync(target, "utf8")).toBe("hello\n");
    const dirStat = fs.statSync(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("appends multiple writes in order on the single-promise queue", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-order-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    w.write("one\n");
    w.write("two\n");
    w.write("three\n");

    await w.flush();

    expect(fs.readFileSync(target, "utf8")).toBe("one\ntwo\nthree\n");
  });
});

describe("QueuedFileWriter.write — backpressure (maxQueuedBytes)", () => {
  it("returns 'queued' while under the queued-bytes cap and 'dropped' once over", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-backpressure-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target, {
      maxQueuedBytes: 10,
    });

    // First 10 bytes are under the cap.
    expect(w.write("12345")).toBe("queued");
    expect(w.write("67890")).toBe("queued");
    // Eleventh byte would push past the cap.
    expect(w.write("X")).toBe("dropped");

    await w.flush();
  });

  it("exposes queuedBytes() introspection that drops to 0 after flush()", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-introspect-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    w.write("abc");
    w.write("defg");
    // Pre-flush: queuedBytes reflects the pending in-flight bytes (3 + 4 = 7).
    expect(w.queuedBytes()).toBeGreaterThan(0);

    await w.flush();
    expect(w.queuedBytes()).toBe(0);
  });
});

describe("QueuedFileWriter.flushAndClose — removes writer from the LRU map", () => {
  it("removes the writer from the passed Map and renders subsequent getQueuedFileWriter() a fresh instance", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-close-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "out.jsonl");
    const w1 = getQueuedFileWriter(writers, target);
    w1.write("first\n");

    await w1.flushAndClose();
    expect(writers.has(target)).toBe(false);

    const w2 = getQueuedFileWriter(writers, target);
    expect(w2).not.toBe(w1);

    w2.write("second\n");
    await w2.flush();
    expect(fs.readFileSync(target, "utf8")).toBe("first\nsecond\n");
  });
});

describe("QueuedFileWriter — uses appendRegularFile semantics (mode 0o600 on the file)", () => {
  it("creates the target file with mode 0o600 (the appendRegularFile contract)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-perm-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    w.write("payload\n");
    await w.flush();

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("QueuedFileWriter — yieldBeforeWrite default behavior", () => {
  it("yields to the event loop before the underlying write so sync callers see queued status immediately", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-yield-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    // Immediately after write() the file should NOT yet exist on disk (yield
    // pushes the actual fs work to a microtask continuation).
    w.write("first\n");
    expect(fs.existsSync(target)).toBe(false);

    await w.flush();
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("QueuedFileWriter — failure introspection", () => {
  // The writer used to silently swallow the Result returned by
  // appendRegularFile. These cases lock in the observability surface:
  // failureCount() + lastError() + rejectedBytes().

  it("starts with failureCount === 0 and lastError === undefined and rejectedBytes === 0 before any writes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-baseline-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "baseline.jsonl");
    const w = getQueuedFileWriter(writers, target);

    expect(w.failureCount()).toBe(0);
    expect(w.lastError()).toBeUndefined();
    expect(w.rejectedBytes()).toBe(0);
  });

  it("increments failureCount and captures lastError as SymlinkParentRejected when appendRegularFile rejects a symlinked parent", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-symlink-fail-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "evil-link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);

    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(linkDir, "writes.jsonl");
    const w = getQueuedFileWriter(writers, target);

    w.write("line one\n");
    await w.flushAndClose();

    expect(w.failureCount()).toBeGreaterThanOrEqual(1);
    const err = w.lastError();
    expect(err).toBeInstanceOf(Error);
    // SymlinkParentRejected carries name "SymlinkParentRejected" and the
    // message includes "symlinked parent".
    expect(String(err)).toMatch(/symlink|SymlinkParentRejected/i);
  });

  it("keeps failureCount at 0 and lastError undefined under normal conditions across many writes", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-happy-"));
    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(tmpDir, "happy.jsonl");
    const w = getQueuedFileWriter(writers, target);

    for (let i = 0; i < 10; i++) {
      w.write(`line ${i}\n`);
    }
    await w.flushAndClose();

    expect(w.failureCount()).toBe(0);
    expect(w.lastError()).toBeUndefined();
    expect(w.rejectedBytes()).toBe(0);
  });

  it("accumulates rejectedBytes equal to the total byte length of rejected lines", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-bytes-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "evil-link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);

    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(linkDir, "rejected.jsonl");
    const w = getQueuedFileWriter(writers, target);

    // Three writes with known UTF-8 byte lengths (ASCII = byte-per-char).
    w.write("a\n"); // 2 bytes
    w.write("bb\n"); // 3 bytes
    w.write("ccc\n"); // 4 bytes
    await w.flushAndClose();

    expect(w.failureCount()).toBe(3);
    expect(w.rejectedBytes()).toBe(2 + 3 + 4);
  });
});

// ---------------------------------------------------------------------------
// Defensive 0o700 chmod on existing parent dir.
//
// Non-observability subsystems (pino-roll, pi-mono) create the artifact
// parent dirs FIRST under default umask (0o755). mkdir's `mode` arg is
// silently ignored when the dir already exists (recursive EEXIST). The
// fix: after mkdirSync, defensively chmod the parent to 0o700 — gated
// on a non-symlink lstat to preserve the confused-deputy invariant.
// ---------------------------------------------------------------------------
describe("QueuedFileWriter — defensive 0o700 chmod on existing parent dir", () => {
  it("chmods an existing parent dir from 0o755 to 0o700 on first write through the writer", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-existing-755-"));
    const parentDir = path.join(tmpDir, "logs");
    // Pre-create the parent at 0o755 simulating pino-roll / pi-mono creating
    // it first under default umask. The chmod is explicit to be deterministic
    // across umask variations on the test runner.
    fs.mkdirSync(parentDir, { recursive: true });
    fs.chmodSync(parentDir, 0o755);
    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o755);

    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(parentDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    w.write("hello\n");
    await w.flush();

    // After the first write, the parent dir must be 0o700 (defensive chmod).
    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o700);
  });

  it("does NOT chmod a symlinked parent dir (confused-deputy guard via lstat)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-symlink-parent-"));
    // The symlink target is operator-owned shared state OUTSIDE our trust
    // boundary — we must never mutate its mode. The lstat-isSymbolicLink
    // gate is the confused-deputy invariant guard.
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "evil-link");
    fs.mkdirSync(realDir);
    fs.chmodSync(realDir, 0o755);
    fs.symlinkSync(realDir, linkDir);
    expect(fs.statSync(realDir).mode & 0o777).toBe(0o755);

    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(linkDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    w.write("payload\n");
    await w.flushAndClose();

    // The symlink target's mode MUST NOT have been mutated. The write
    // itself may or may not succeed (appendRegularFile rejects symlinked
    // parents) — what matters is that the underlying real dir is untouched.
    expect(fs.statSync(realDir).mode & 0o777).toBe(0o755);
  });

  it("creates a fresh parent dir at 0o700 (regression guard — mkdir mode still applies)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qfw-fresh-create-"));
    const parentDir = path.join(tmpDir, "fresh-logs");
    // Parent does NOT pre-exist — the mkdirSync({mode: 0o700}) branch
    // creates it at 0o700 directly.
    expect(fs.existsSync(parentDir)).toBe(false);

    const writers = new Map<string, QueuedFileWriter>();
    const target = path.join(parentDir, "out.jsonl");
    const w = getQueuedFileWriter(writers, target);

    w.write("payload\n");
    await w.flush();

    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o700);
  });
});
