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
