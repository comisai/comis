// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the `result-ref-store` — the workspace-confined disk I/O + GC
 * that materializes a high-volume tool return to `<workspace>/results/<id>.<kind>`
 * and returns a structured `ResultRef` (REF-01/02/03).
 *
 * RED-first (TDD): these fail at suite-load on pre-patch code (the module does
 * not exist) and go green once `result-ref-store.ts` ships.
 *
 * All paths are confined to a per-test temp workspace; all time is injected
 * (`nowMs`) so the suite is deterministic and macOS-runnable (no bwrap).
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PER_FILE_CAP_BYTES } from "@comis/core";
import { createResultRefStore } from "./result-ref-store.js";

// A silent logger stub (the store instruments via deps.logger; we don't assert
// on log output here — the gates do — so a no-op child-able logger suffices).
function makeLogger(): import("@comis/core").ComisLogger {
  const noop = (): void => {};
  const logger: import("@comis/core").ComisLogger = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    audit: noop,
    child: () => logger,
  };
  return logger;
}

describe("result-ref-store", () => {
  let workspacePath: string;
  const runId = "run-abc123";
  const nowMs = 1_700_000_000_000;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "comis-result-ref-store-"));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  function makeStore(): ReturnType<typeof createResultRefStore> {
    return createResultRefStore({ logger: makeLogger() });
  }

  it("materializes a payload to <workspace>/results/<id> and returns a workspace-relative ResultRef", async () => {
    const store = makeStore();
    const payload = "hello from web_fetch ".repeat(50);

    const ref = await store.materialize(payload, "web_fetch", {
      workspacePath,
      runId,
      nowMs,
    });

    // The result is a structured ResultRef (not a string, not an error).
    expect(ref).toBeDefined();
    if (ref === undefined || "error" in ref) {
      throw new Error(`expected a ResultRef, got ${JSON.stringify(ref)}`);
    }

    // The ref path is WORKSPACE-relative and lives under results/.
    expect(ref.ref).toMatch(/^results\//);
    expect(ref.bytes).toBe(Buffer.byteLength(payload, "utf8"));
    expect(typeof ref.expiresAt).toBe("string");
    expect(Number.isNaN(Date.parse(ref.expiresAt))).toBe(false);

    // The file exists on disk at <workspace>/<ref.ref> with the exact payload.
    const onDisk = join(workspacePath, ref.ref);
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, "utf8")).toBe(payload);
  });

  it("bounds the preview to a small cap regardless of payload size", async () => {
    const store = makeStore();
    const payload = "X".repeat(500_000); // 500 KB

    const ref = await store.materialize(payload, "web_fetch", {
      workspacePath,
      runId,
      nowMs,
    });
    if (ref === undefined || "error" in ref) {
      throw new Error("expected a ResultRef");
    }

    // The preview re-enters context with the handle — it MUST stay tiny even
    // though the payload is half a megabyte.
    expect(ref.preview.length).toBeLessThanOrEqual(2048);
    expect(ref.bytes).toBe(500_000);
  });

  it("infers kind html for an HTML payload from web_fetch", async () => {
    const store = makeStore();
    const html = "<!DOCTYPE html><html><body><h1>hi</h1></body></html>";

    const ref = await store.materialize(html, "web_fetch", {
      workspacePath,
      runId,
      nowMs,
    });
    if (ref === undefined || "error" in ref) throw new Error("expected a ResultRef");

    expect(ref.kind).toBe("html");
    expect(ref.ref).toMatch(/\.html$/);
  });

  it("infers kind json for a JSON-object payload", async () => {
    const store = makeStore();
    const jsonPayload = JSON.stringify({ a: 1, b: [2, 3], c: "four" });

    const ref = await store.materialize(jsonPayload, "memory_search", {
      workspacePath,
      runId,
      nowMs,
    });
    if (ref === undefined || "error" in ref) throw new Error("expected a ResultRef");

    expect(ref.kind).toBe("json");
    expect(ref.ref).toMatch(/\.json$/);
  });

  it("infers kind jsonl for a newline-delimited-JSON payload", async () => {
    const store = makeStore();
    const jsonl = ['{"row":1}', '{"row":2}', '{"row":3}'].join("\n");

    const ref = await store.materialize(jsonl, "memory_search", {
      workspacePath,
      runId,
      nowMs,
    });
    if (ref === undefined || "error" in ref) throw new Error("expected a ResultRef");

    expect(ref.kind).toBe("jsonl");
    expect(ref.ref).toMatch(/\.jsonl$/);
  });

  it("infers kind text for a plain-text payload", async () => {
    const store = makeStore();
    const text = "just some plain prose, nothing structured here.";

    const ref = await store.materialize(text, "read", {
      workspacePath,
      runId,
      nowMs,
    });
    if (ref === undefined || "error" in ref) throw new Error("expected a ResultRef");

    expect(ref.kind).toBe("text");
    expect(ref.ref).toMatch(/\.text$/);
  });

  it("infers kind binary and writes the bytes for a Buffer payload", async () => {
    const store = makeStore();
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);

    const ref = await store.materialize(buf, "web_fetch", {
      workspacePath,
      runId,
      nowMs,
    });
    if (ref === undefined || "error" in ref) throw new Error("expected a ResultRef");

    expect(ref.kind).toBe("binary");
    expect(ref.bytes).toBe(buf.byteLength);
    const onDisk = join(workspacePath, ref.ref);
    expect(readFileSync(onDisk).equals(buf)).toBe(true);
  });

  it("refuses a payload exceeding the per-file cap and writes nothing (REF-03)", async () => {
    const store = makeStore();
    // One byte over the per-file cap (use a Buffer so we don't allocate a giant
    // UTF-8 string char-by-char; the byte count is what the cap checks).
    const tooBig = Buffer.alloc(PER_FILE_CAP_BYTES + 1, 0x41);

    const ref = await store.materialize(tooBig, "web_fetch", {
      workspacePath,
      runId,
      nowMs,
    });

    // The store returns a content-free error shape (NOT a ResultRef) ...
    expect(ref).toBeDefined();
    expect(ref !== undefined && "error" in ref).toBe(true);

    // ... and NOTHING is written under results/ (no partial/clamped file).
    const resultsDir = join(workspacePath, "results");
    const entries = existsSync(resultsDir) ? readdirSync(resultsDir) : [];
    expect(entries.length).toBe(0);
  });

  it("gcRun evicts the oldest results past the per-run aggregate cap, keeps the newest (REF-03)", async () => {
    const store = makeStore();

    // Write three results at increasing timestamps. Each is ~4 bytes; we set a
    // tiny aggregate cap so two of the three must be evicted.
    const refs = [];
    for (let i = 0; i < 3; i++) {
      const ref = await store.materialize(`pay${i}`, "read", {
        workspacePath,
        runId,
        nowMs: nowMs + i * 1000, // older → newer
      });
      if (ref === undefined || "error" in ref) throw new Error("materialize failed");
      refs.push(ref);
    }

    const resultsDir = join(workspacePath, "results");
    expect(readdirSync(resultsDir).length).toBe(3);

    // Aggregate cap that only fits ONE ~4-byte file → evict the two oldest.
    await store.gcRun({
      workspacePath,
      runId,
      aggregateCapBytes: 5,
      nowMs: nowMs + 10_000,
    });

    const survivors = readdirSync(resultsDir);
    expect(survivors.length).toBe(1);
    // The newest (refs[2]) survives; the two older are gone.
    const newestFile = refs[2]!.ref.replace(/^results\//, "");
    expect(survivors).toContain(newestFile);
    expect(existsSync(join(workspacePath, refs[0]!.ref))).toBe(false);
    expect(existsSync(join(workspacePath, refs[1]!.ref))).toBe(false);
  });

  it("gcRun also evicts expired results past their TTL (REF-03)", async () => {
    const store = makeStore();

    // A short TTL → the file expires well before the gc nowMs.
    const ref = await store.materialize("ephemeral", "read", {
      workspacePath,
      runId,
      nowMs,
      ttlMs: 1000,
    });
    if (ref === undefined || "error" in ref) throw new Error("materialize failed");
    expect(existsSync(join(workspacePath, ref.ref))).toBe(true);

    // GC long after expiry, with a huge aggregate cap (so only TTL drives it).
    await store.gcRun({
      workspacePath,
      runId,
      aggregateCapBytes: 1024 * 1024,
      nowMs: nowMs + 10_000, // past expiresAt (nowMs + 1000)
    });

    expect(existsSync(join(workspacePath, ref.ref))).toBe(false);
  });

  it("cleanupRun removes the run's results entries on run end (REF-03)", async () => {
    const store = makeStore();

    await store.materialize("a".repeat(100), "read", { workspacePath, runId, nowMs });
    await store.materialize("b".repeat(100), "read", { workspacePath, runId, nowMs });

    const resultsDir = join(workspacePath, "results");
    expect(readdirSync(resultsDir).length).toBe(2);

    await store.cleanupRun({ workspacePath, runId });

    // The run's results are gone (the dir is emptied or removed).
    const remaining = existsSync(resultsDir) ? readdirSync(resultsDir) : [];
    expect(remaining.length).toBe(0);
  });

  it("rejects a traversal in the run/id and never writes outside <workspace>/results (path containment)", async () => {
    const store = makeStore();

    // A sentinel OUTSIDE the workspace we must never clobber.
    const outsideDir = mkdtempSync(join(tmpdir(), "comis-outside-sentinel-"));
    const sentinel = join(outsideDir, "escaped.txt");
    try {
      // A crafted runId that tries to climb out of results/.
      const malicious = await store.materialize("evil", "read", {
        workspacePath,
        runId: "../../../../../../../../tmp",
        nowMs,
      });

      // Either it is refused (error/undefined) OR it is safely confined — but
      // in NO case may anything land outside the workspace.
      if (malicious !== undefined && !("error" in malicious)) {
        const onDisk = join(workspacePath, malicious.ref);
        expect(onDisk.startsWith(workspacePath)).toBe(true);
      }
      // The outside sentinel path must not have been created by the store.
      expect(existsSync(sentinel)).toBe(false);

      // No results/ file may have escaped the workspace root.
      const resultsDir = join(workspacePath, "results");
      if (existsSync(resultsDir)) {
        for (const entry of readdirSync(resultsDir)) {
          expect(join(resultsDir, entry).startsWith(resultsDir)).toBe(true);
        }
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not throw when gcRun runs against a run that has no results dir yet", async () => {
    const store = makeStore();
    // Best-effort GC on an empty/absent results dir must be a no-op, not a throw.
    await expect(
      store.gcRun({ workspacePath, runId, aggregateCapBytes: 10, nowMs }),
    ).resolves.toBeUndefined();
  });
});
