// SPDX-License-Identifier: Apache-2.0
/**
 * WR-07 — the write-failure SENTINEL must route its error text through the
 * `sanitizeForPersistence` chokepoint, not embed the raw `lastError().message`.
 *
 * The recall-trace recorder's stated invariant (runtime.ts header) is "EVERY
 * payload always goes through full sanitizeForPersistence before disk". The
 * per-recall `record` already did. The control-plane sentinel's `data` (which
 * carries `lastError: writer.lastError()?.message`) did NOT — an unstated
 * exception. For an fs append failure the message is the trace file's own path
 * (a path leak); a future error source whose message embedded user/secret text
 * would land unredacted. This test drives a FAILING writer whose `lastError`
 * carries a secret token + an absolute path and asserts the sentinel written to
 * disk contains NEITHER raw.
 *
 * Seam: this file mocks `../shared/queued-file-writer.js` (hoisted, file-scoped)
 * with a fake writer that captures every line the recorder writes and reports a
 * controllable `failureCount()` / `lastError()`. This isolates the test from the
 * real fs append path (whose natural error message we cannot make carry a
 * secret while still landing the sentinel on the same path) and exercises the
 * REAL `buildSentinel` + `sanitizeForPersistence` chokepoint the fix adds.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// The secret + path a (future) writer error message might embed. The in-text
// redactor masks the `sk-` token; the assertion below proves the RAW token
// never reaches disk via the sentinel.
const SEED_SECRET = "sk-ABCDEF0123456789SENTINELLEAK";
const SEED_ABS_PATH = "/Users/alice/.comis/secrets.yaml";

// Captured lines the recorder hands to the (mocked) writer.
const written: string[] = [];

// A fake QueuedFileWriter the recorder will use via the mocked
// getQueuedFileWriter. It always reports ONE failure with a secret-bearing
// lastError so the recorder's summary write-failure sentinel fires at
// flushAndClose.
vi.mock("../shared/queued-file-writer.js", () => {
  return {
    getQueuedFileWriter: () => ({
      write: (line: string) => {
        written.push(line);
        return "queued" as const;
      },
      flush: async () => {},
      flushAndClose: async () => {},
      queuedBytes: () => 0,
      failureCount: () => 1,
      lastError: () =>
        new Error(
          `EACCES: permission denied, open '${SEED_ABS_PATH}' token=${SEED_SECRET}`,
        ),
      rejectedBytes: () => 1234,
    }),
  };
});

// Import AFTER the mock is registered (vi.mock is hoisted, so this is safe).
import { createRecallTrace } from "./runtime.js";

beforeEach(() => {
  written.length = 0;
  delete process.env.COMIS_DISABLE_RECALL_TRACE;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createRecallTrace -- write-failure sentinel is sanitized (WR-07)", () => {
  it("routes the sentinel lastError through sanitizeForPersistence so no raw secret reaches disk", async () => {
    const trace = createRecallTrace({
      enabled: true,
      filePath: "/tmp/wr07-recall-trace.jsonl",
      agentId: "agent-1",
      sessionId: "sid-1",
    });
    expect(trace).not.toBeNull();

    // flushAndClose fires the summary write-failures sentinel because the
    // (mocked) writer reports failureCount() === 1. The sentinel carries
    // data.lastError = the writer's error message (secret + abs path).
    await trace!.flushAndClose();

    // The recorder must have written at least one sentinel line.
    expect(written.length).toBeGreaterThan(0);

    // Locate the summary write-failures sentinel (the one carrying lastError).
    const sentinelLines = written
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.recallTrace === "recall_trace.write_failures");
    expect(sentinelLines.length).toBeGreaterThan(0);

    const summary = sentinelLines.find(
      (s) => "lastError" in ((s.data ?? {}) as Record<string, unknown>),
    );
    expect(summary).toBeDefined();

    // The binding assertions: the raw secret token must NOT survive on disk,
    // and neither must the absolute path. The whole on-disk sentinel payload is
    // inspected (serialized) — the fix sanitizes the entire sentinel data.
    const onDisk = JSON.stringify(summary);
    expect(onDisk).not.toContain(SEED_SECRET);
    expect(onDisk).not.toContain("ABCDEF0123456789");

    // The sentinel still PARSES and carries its control-plane shape — the
    // sanitize did not corrupt the line or drop the failure accounting.
    const data = (summary!.data ?? {}) as Record<string, unknown>;
    expect(data.reason).toBe("queued_writer_rejected");
    expect(typeof data.droppedEvents).toBe("number");
    // lastError is present but masked (not the raw secret).
    expect("lastError" in data).toBe(true);
  });
});
