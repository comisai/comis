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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PER_FILE_CAP_BYTES } from "@comis/core";
import { buildPreview, createResultRefStore, inferKind } from "./result-ref-store.js";

// Spy on execFile so the slice-only guarantee test can drive the `sql` core's
// daemon-side duckdb with a controlled tiny row-slice stdout — proving ONLY the
// slice (not the materialized payload) crosses back. The default implementation
// delegates to the real execFile (untouched for any other consumer in this file).
const { execFileSpy } = vi.hoisted(() => ({ execFileSpy: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  execFileSpy.mockImplementation((...args: unknown[]) =>
    (actual.execFile as unknown as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, execFile: execFileSpy };
});

import { createOrchestrateExecutorCores } from "./orchestrate-executor-cores.js";

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

  it("cleanupRun is a no-op (no throw) when the run has no results dir", async () => {
    const store = makeStore();
    await expect(
      store.cleanupRun({ workspacePath, runId }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined (honest-degrade) when the contained write fails", async () => {
    const store = makeStore();

    // Make the write fail deterministically: pre-create `<workspace>/results`
    // as a FILE, so `ensureContainedDir` cannot mkdir the dir there. The store
    // must honest-degrade (undefined), never throw, and write nothing.
    const resultsAsFile = join(workspacePath, "results");
    writeFileSync(resultsAsFile, "I am a file, not a directory");

    const out = await store.materialize("payload", "read", {
      workspacePath,
      runId,
      nowMs,
    });

    expect(out).toBeUndefined();
    // The pre-existing file is untouched (no clobber); no dir was created.
    expect(readFileSync(resultsAsFile, "utf8")).toBe("I am a file, not a directory");
  });

  it("gcRun leaves a foreign (non-scheme) file unless the aggregate cap forces it out", async () => {
    const store = makeStore();

    // A file in results/ that does NOT match the store's `<c36>-<s36>-<e36>`
    // basename scheme → parseStamps falls back (never TTL-expired). With a huge
    // aggregate cap, a TTL sweep must NOT evict it.
    const resultsDir = join(workspacePath, "results");
    mkdirSync(resultsDir, { recursive: true });
    const foreign = join(resultsDir, "not-a-store-file.txt");
    writeFileSync(foreign, "hand-placed");

    await store.gcRun({
      workspacePath,
      runId,
      aggregateCapBytes: 1024 * 1024, // far above the file size → no cap eviction
      nowMs: nowMs + 10_000_000, // far in the "future" → would TTL-evict a scheme file
    });

    // Survives: the foreign file has no parseable expiry, so TTL never fires.
    expect(existsSync(foreign)).toBe(true);

    // But the aggregate cap still bounds it: a zero-ish cap evicts it.
    await store.gcRun({
      workspacePath,
      runId,
      aggregateCapBytes: 1,
      nowMs: nowMs + 10_000_000,
    });
    expect(existsSync(foreign)).toBe(false);
  });
});

describe("result-ref-store pure helpers", () => {
  describe("inferKind", () => {
    it("returns binary for a Buffer payload", () => {
      expect(inferKind(Buffer.from([1, 2, 3]))).toBe("binary");
    });

    it("returns text for an empty/whitespace-only string", () => {
      expect(inferKind("")).toBe("text");
      expect(inferKind("   \n  \t ")).toBe("text");
    });

    it("returns html for a doctype or <html> root", () => {
      expect(inferKind("<!DOCTYPE html><html></html>")).toBe("html");
      expect(inferKind("<html lang=\"en\"></html>")).toBe("html");
    });

    it("returns json for a single JSON object or array", () => {
      expect(inferKind('{"k":1}')).toBe("json");
      expect(inferKind("[1, 2, 3]")).toBe("json");
    });

    it("returns jsonl for multi-line newline-delimited JSON", () => {
      expect(inferKind('{"a":1}\n{"b":2}')).toBe("jsonl");
    });

    it("returns text for a single JSON-bracketed-looking but INVALID payload", () => {
      // Looks like an object (starts `{`, ends `}`) but does not parse → text,
      // never a mis-labelled `json` (covers the invalid-JSON false branch).
      expect(inferKind("{not valid json}")).toBe("text");
      expect(inferKind("[1, 2,]extra")).toBe("text");
    });

    it("returns text for ordinary prose", () => {
      expect(inferKind("just some words")).toBe("text");
    });
  });

  describe("buildPreview", () => {
    it("returns a content-free descriptor for a binary payload", () => {
      const buf = Buffer.from([0, 1, 2, 3, 4]);
      expect(buildPreview(buf, "binary")).toBe("[binary 5 bytes]");
    });

    it("returns a descriptor for a string payload tagged binary", () => {
      // kind=binary with a string payload (defensive branch) → descriptor by
      // the string's byte length, never the raw content.
      expect(buildPreview("abc", "binary")).toBe("[binary 3 bytes]");
    });

    it("passes a short text payload through unchanged", () => {
      expect(buildPreview("hello", "text")).toBe("hello");
    });

    it("truncates a long text payload to the bounded cap", () => {
      const long = "Y".repeat(10_000);
      const preview = buildPreview(long, "text");
      expect(preview.length).toBeLessThanOrEqual(2048);
      expect(preview.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// QRY-03 / T-221-QRY-07: the slice-only guarantee.
//
// The store materializes a high-volume tabular result to results/<id>; the `sql`
// core (daemon-side DuckDB, Plan 02) runs a SELECT over it and returns ONLY the
// row slice. This test PINS that the payload NEVER re-enters context: it
// materializes a multi-MB JSONL ResultRef, runs a `sql` query that selects 2
// columns of 3 rows, and asserts the returned slice byte-length is « the
// materialized payload byte-length. It FAILS if a regression ever makes the core
// return the whole file instead of the query's slice (unbounded context re-entry
// / cost — the information-disclosure threat the per-file/per-run caps + TTL also
// bound). DuckDB is driven via the execFileSpy (a controlled small row-slice
// stdout), so the test is deterministic + macOS-runnable; the real DuckDB
// round-trip is the VPS orchestrate-jail.linux.test.ts.
// ---------------------------------------------------------------------------

describe("QRY-03 slice-only: a large tabular ResultRef SQL'd returns ONLY the slice, never the payload", () => {
  function makeCoresLogger(): import("@comis/core").ComisLogger {
    const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { child: vi.fn(() => child), ...child } as unknown as import("@comis/core").ComisLogger;
  }

  beforeEach(() => {
    // Reset only the call history; the rejection-screen tests elsewhere depend on
    // the delegating implementation, but this file's slice test sets its own.
    execFileSpy.mockReset();
  });

  it("returns the duckdb row slice whose byte-length is « the materialized multi-MB payload", async () => {
    const store = createResultRefStore({ logger: makeLogger() });
    const workspacePath = mkdtempSync(join(tmpdir(), "comis-slice-only-"));
    try {
      // 1. Build a multi-MB tabular JSONL payload (~3 MB, well above the 15 KB
      //    handle threshold, well below the 8 MiB per-file cap) and materialize it.
      const rowCount = 30_000;
      const rows: string[] = [];
      for (let i = 0; i < rowCount; i++) {
        rows.push(JSON.stringify({ id: i, price: i * 3, label: `widget-${i}-xxxxxxxxxxxxxxxxxxxx` }));
      }
      const payload = rows.join("\n");
      expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(2_000_000); // multi-MB

      const ref = await store.materialize(payload, "web_fetch", {
        workspacePath,
        runId: "run-slice",
        nowMs: 1_700_000_000_000,
      });
      if (ref === undefined || "error" in ref) {
        throw new Error(`expected a ResultRef for the multi-MB payload, got ${JSON.stringify(ref)}`);
      }
      // The handle's preview is already tiny — the payload stays on disk.
      expect(ref.preview.length).toBeLessThanOrEqual(2048);
      expect(ref.bytes).toBe(Buffer.byteLength(payload, "utf8"));

      // 2. Drive the daemon-side duckdb with a controlled SELECT result: the query
      //    asked for 2 columns of 3 rows, so duckdb's -json stdout is exactly that
      //    small row slice (NOT the whole file). This is what DuckDB does for a
      //    `SELECT id, price ... LIMIT 3` — return only the projected/limited rows.
      const sliceRows = [
        { id: 0, price: 0 },
        { id: 1, price: 3 },
        { id: 2, price: 6 },
      ];
      const sliceStdout = JSON.stringify(sliceRows);
      execFileSpy.mockImplementation(
        (_bin: unknown, _argv: unknown, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
          cb(null, sliceStdout, "");
          return undefined;
        },
      );

      const cores = createOrchestrateExecutorCores({ logger: makeCoresLogger() });
      const result = await cores.fileExecutors.sql(
        {
          path: ref.ref,
          query: `SELECT id, price FROM read_json_auto('${ref.ref}') LIMIT 3`,
        },
        { workspaceDir: workspacePath },
      );

      // 3. The core returns ONLY the slice (the duckdb stdout), never the payload.
      expect(typeof result).toBe("string");
      const slice = result as string;
      expect(slice).toBe(sliceStdout);

      // The load-bearing pin: the slice is ORDERS of magnitude smaller than the
      // materialized payload. If a regression made the core read+return the whole
      // results/ file, slice.length would be ~ref.bytes and this fails hard.
      expect(slice.length).toBeLessThan(ref.bytes / 1000);
      expect(slice.length).toBeLessThan(2048);

      // duckdb was invoked exactly once over the confined results/ path — the file
      // contents were never handed back through the core's return value.
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      const [bin, argv] = execFileSpy.mock.calls[0] as [string, string[]];
      expect(bin).toBe("duckdb");
      // The query references read_json_auto over the run-scoped file, not a file read.
      const cFlagIdx = argv.indexOf("-c");
      expect(argv[cFlagIdx + 1]).toContain("read_json_auto");
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
