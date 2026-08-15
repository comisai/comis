// SPDX-License-Identifier: Apache-2.0
/**
 * `resolveTraceToSession` tests — the identity-canonicalization seam.
 *
 * `obs.explain` accepts EITHER a `sessionKey` OR a `traceId`. For the
 * by-traceId path to run the SAME assembler as the by-sessionKey path
 * (identity is structural, not two parallel code paths), `traceId` must
 * resolve to its canonical `sessionKey` FIRST. The 678 fixture is a
 * multi-turn session: it has TWO traceIds
 * (`f942d38c-…` first turn, `058db0fe-…` second turn) that BOTH map to the
 * ONE sessionKey `default:678314278:678314278:peer:678314278`.
 *
 * These tests pin:
 *   - both 678 traceIds resolve to the one canonical sessionKey (one identity)
 *   - a child run id resolves through the structurally parsed sub-agent channel
 *   - a `sessionId`-only row (no `sessionKey`) still resolves
 *   - unknown traceId → "" (soft-fail, no throw)
 *   - missing session-index file → "" (soft-fail, no throw)
 *   - malformed JSON lines are skipped, not fatal
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { systemDateFrom, systemNowMs } from "@comis/core";
import {
  resolveRootRunToSession,
  resolveTraceReference,
  resolveTraceToSession,
} from "./obs-explain-resolve.js";

// The 678 fixture's two traceIds and the single canonical sessionKey.
const TRACE_TURN_1 = "f942d38c-e372-43cc-99f1-ead4f0b8582f";
const TRACE_TURN_2 = "058db0fe-651f-4362-908f-babd8208afa3";
const CANONICAL_SESSION_KEY = "default:678314278:678314278:peer:678314278";
const CHILD_RUN_ID = "32e91601-c71e-4386-bc16-f87867ca6aff";
const CHILD_SESSION_KEY =
  `default:agent:default:user_a:sub-agent:runtime:${CHILD_RUN_ID}:peer:user_a`;

function todayKey(): string {
  return systemDateFrom(systemNowMs()).toISOString().slice(0, 10);
}

/**
 * Create a temp dataDir with a `logs/session-index.<today>.jsonl` containing
 * the supplied JSONL lines (already serialized). Returns the dataDir.
 */
function makeDataDirWithIndex(lines: string[]): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-resolve-"));
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `session-index.${todayKey()}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return dataDir;
}

describe("resolveTraceToSession", () => {
  it("resolves the 678 first-turn traceId to the canonical sessionKey", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY }),
    ]);
    const resolved = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    expect(resolved).toBe(CANONICAL_SESSION_KEY);
  });

  it("resolves the 678 second-turn traceId to the SAME canonical sessionKey (multi-turn identity)", async () => {
    // Both turns are present in the index; the second turn must converge on
    // the identical sessionKey — two traceIds, one resolution target.
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY }),
      JSON.stringify({ traceId: TRACE_TURN_2, sessionKey: CANONICAL_SESSION_KEY }),
    ]);
    const first = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    const second = await resolveTraceToSession(dataDir, TRACE_TURN_2);
    expect(second).toBe(CANONICAL_SESSION_KEY);
    // The identity invariant: BOTH traceIds resolve to ONE canonical key.
    expect(second).toBe(first);
  });

  it("falls back to a sessionId-derived key when the row carries sessionId but no sessionKey", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionId: "678314278" }),
    ]);
    const resolved = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    expect(resolved).toBe("678314278");
  });

  it("returns empty string for an unknown traceId without throwing (soft-fail)", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY }),
    ]);
    const resolved = await resolveTraceToSession(dataDir, "no-such-trace-id");
    expect(resolved).toBe("");
  });

  it("returns empty string when the session-index file is absent (soft-fail)", async () => {
    const emptyDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "obs-explain-resolve-empty-"),
    );
    const resolved = await resolveTraceToSession(emptyDataDir, TRACE_TURN_1);
    expect(resolved).toBe("");
  });

  it("skips malformed JSON lines without throwing and still resolves a later valid row", async () => {
    const dataDir = makeDataDirWithIndex([
      "{ this is not valid json",
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY }),
      "}}}also broken",
    ]);
    const resolved = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    expect(resolved).toBe(CANONICAL_SESSION_KEY);
  });

  it("falls back to the default ~/.comis data dir when an empty dataDir is passed (soft-fail to '')", async () => {
    // Empty dataDir → defaultDataDir() (~/.comis). No matching index there for a
    // synthetic trace → "" without throwing. Exercises the default-dir branch.
    const resolved = await resolveTraceToSession("", "synthetic-trace-that-does-not-exist-anywhere");
    expect(resolved).toBe("");
  });

  it("ignores a row whose sessionKey/sessionId are absent and keeps scanning", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1 }), // matches traceId but no key/id
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY }),
    ]);
    const resolved = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    expect(resolved).toBe(CANONICAL_SESSION_KEY);
  });

  // Synthetic (test/harness) rows are excluded by default; includeSynthetic opts in.

  it("returns empty string when ONLY a synthetic row carries the traceId (default-exclude)", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY, synthetic: true }),
    ]);
    const resolved = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    expect(resolved).toBe("");
  });

  it("resolves a synthetic row's traceId to its sessionKey when includeSynthetic is true", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY, synthetic: true }),
    ]);
    const resolved = await resolveTraceToSession(dataDir, TRACE_TURN_1, true);
    expect(resolved).toBe(CANONICAL_SESSION_KEY);
  });

  it("resolves a runtime (non-synthetic) row regardless of the includeSynthetic flag", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY }),
    ]);
    const off = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    const on = await resolveTraceToSession(dataDir, TRACE_TURN_1, true);
    expect(off).toBe(CANONICAL_SESSION_KEY);
    expect(on).toBe(CANONICAL_SESSION_KEY);
  });

  it("resolves a sub-agent run identifier from the canonical indexed session key", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        traceId: "child-trace-id",
        sessionKey: CHILD_SESSION_KEY,
      }),
    ]);

    const resolved = await resolveTraceToSession(dataDir, CHILD_RUN_ID);

    expect(resolved).toBe(CHILD_SESSION_KEY);
  });

  it("preserves the indexed execution trace when resolving a sub-agent run identifier", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        traceId: "child-trace-id",
        sessionKey: CHILD_SESSION_KEY,
      }),
    ]);

    const resolved = await resolveTraceReference(dataDir, CHILD_RUN_ID);

    expect(resolved).toEqual({
      sessionKey: CHILD_SESSION_KEY,
      traceId: "child-trace-id",
    });
  });

  it("resolves a restarted sub-agent run to its latest execution trace", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        event: "execution_started",
        ts: "2026-08-15T15:08:59.939Z",
        traceId: "pre-restart-trace-id",
        sessionKey: CHILD_SESSION_KEY,
      }),
      JSON.stringify({
        event: "turn_completed",
        ts: "2026-08-15T15:10:02.777Z",
        traceId: "pre-restart-trace-id",
        sessionKey: CHILD_SESSION_KEY,
        stopReason: "aborted",
      }),
      JSON.stringify({
        event: "execution_started",
        ts: "2026-08-15T15:10:21.329Z",
        traceId: "resumed-trace-id",
        sessionKey: CHILD_SESSION_KEY,
      }),
      JSON.stringify({
        event: "turn_completed",
        ts: "2026-08-15T15:13:34.601Z",
        traceId: "resumed-trace-id",
        sessionKey: CHILD_SESSION_KEY,
        stopReason: "stop",
      }),
    ]);

    const resolved = await resolveTraceReference(dataDir, CHILD_RUN_ID);

    expect(resolved).toEqual({
      sessionKey: CHILD_SESSION_KEY,
      traceId: "resumed-trace-id",
    });
  });

  it("does not resolve a run identifier found outside the sub-agent channel", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        traceId: "other-trace-id",
        sessionKey: `default:agent:default:user_a:telegram:chat:peer:${CHILD_RUN_ID}`,
      }),
    ]);

    const resolved = await resolveTraceToSession(dataDir, CHILD_RUN_ID);

    expect(resolved).toBe("");
  });

  it("prefers an exact trace match over an earlier child run fallback", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        traceId: "child-trace-id",
        sessionKey: CHILD_SESSION_KEY,
      }),
      JSON.stringify({
        traceId: CHILD_RUN_ID,
        sessionKey: CANONICAL_SESSION_KEY,
      }),
    ]);

    const resolved = await resolveTraceToSession(dataDir, CHILD_RUN_ID);

    expect(resolved).toBe(CANONICAL_SESSION_KEY);
  });

  it("treats a string 'true' synthetic field as NON-synthetic and still resolves (strict === true)", async () => {
    // Untrusted JSONL: only a real boolean true excludes — a string must not be
    // truthy-coerced into a spurious exclusion of a real session.
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({ traceId: TRACE_TURN_1, sessionKey: CANONICAL_SESSION_KEY, synthetic: "true" }),
    ]);
    const resolved = await resolveTraceToSession(dataDir, TRACE_TURN_1);
    expect(resolved).toBe(CANONICAL_SESSION_KEY);
  });
});

// ---------------------------------------------------------------------------
// resolveRootRunToSession: the THIRD canonicalization arm. A
// `rootRunId` (an autonomy run) is canonicalized to the run's sessionKey FIRST,
// so the system→explain drill-down (paste the worst run's rootRunId) shares the
// ONE assembler path. TWO honest sources:
//   1. a generated SYNTHETIC in-process root carrying its formatted session key
//      — a pure prefix parse, NO I/O.
//   2. a REAL socket/spawned root — scan the day-keyed session-index for a
//      capability.audited record (events-orchestration.ts:90-104 carries BOTH
//      `rootRunId` + `runId`) and return its runId (≈sessionKey).
// Soft-fail to "" on miss — NEVER fabricate a sessionKey.
// ---------------------------------------------------------------------------

describe("resolveRootRunToSession", () => {
  it("resolves the generated synthetic in-process root shape without reading the session index", async () => {
    // `root-session-<generation>-<agentId>-<formattedKey>` carries a unique
    // execution generation before the canonical session key. A pure string op
    // — pass a dataDir with NO index at all to prove no file access is required.
    const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-rootrun-synthetic-"));
    const resolved = await resolveRootRunToSession(
      emptyDataDir,
      "root-session-11111111-1111-4111-8111-111111111111-default-default:agent:default:user:telegram:1717000000",
    );
    expect(resolved).toBe("default:agent:default:user:telegram:1717000000");
  });

  it("resolves a synthetic in-process root when the agent identifier contains hyphens", async () => {
    const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-rootrun-hyphenated-"));
    const resolved = await resolveRootRunToSession(
      emptyDataDir,
      "root-session-11111111-1111-4111-8111-111111111111-release-agent-default:agent:release-agent:user:telegram:1717000000",
    );
    expect(resolved).toBe("default:agent:release-agent:user:telegram:1717000000");
  });

  it("resolves a REAL rootRunId by scanning a real nested session-index layout (AGENTS §2.10)", async () => {
    // Build the ACTUAL <dataDir>/logs/session-index.<dayKey>.jsonl layout (not a
    // flat fixture) so the day-key PATH resolution is exercised, not just the
    // match LOGIC. The row is a capability.audited record carrying BOTH ids under
    // `data` (the canonical trajectory-record shape the spawn-tree fold reads).
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        traceSchema: "comis-trajectory",
        type: "capability.audited",
        event: "capability_audited",
        data: { rootRunId: "run-abc-123", runId: "default:u:c:42", decision: "allow" },
      }),
    ]);
    const resolved = await resolveRootRunToSession(dataDir, "run-abc-123");
    expect(resolved).toBe("default:u:c:42");
  });

  it("resolves a cron root through its scheduler execution trace entry", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        traceSchema: "comis-session-index",
        schemaVersion: 1,
        event: "turn_completed",
        traceId: "execution-cron-a",
        sessionId: "default:agent:default:scheduler-cron:scheduler:job-a:peer:scheduler-cron",
      }),
    ]);

    const resolved = await resolveRootRunToSession(dataDir, "root-cron-execution-cron-a");

    expect(resolved).toBe("default:agent:default:scheduler-cron:scheduler:job-a:peer:scheduler-cron");
  });

  it("soft-fails to '' for an unknown rootRunId — NEVER fabricates a sessionKey", async () => {
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        type: "capability.audited",
        data: { rootRunId: "run-abc-123", runId: "default:u:c:42" },
      }),
    ]);
    const resolved = await resolveRootRunToSession(dataDir, "run-does-not-exist");
    expect(resolved).toBe("");
  });

  it("soft-fails to '' when the session-index file is entirely absent (no throw)", async () => {
    const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-rootrun-empty-"));
    const resolved = await resolveRootRunToSession(emptyDataDir, "run-abc-123");
    expect(resolved).toBe("");
  });

  it("skips malformed JSONL lines and still resolves a later valid capability.audited row", async () => {
    const dataDir = makeDataDirWithIndex([
      "{ not valid json",
      JSON.stringify({
        type: "capability.audited",
        data: { rootRunId: "run-xyz", runId: "default:u:c:9" },
      }),
      "}}}broken",
    ]);
    const resolved = await resolveRootRunToSession(dataDir, "run-xyz");
    expect(resolved).toBe("default:u:c:9");
  });

  it("a synthetic-prefixed id wins by parsing even if a same-named index row exists", async () => {
    // The `root-session-` prefix is the disambiguator: a synthetic root parses
    // its embedded formatted key WITHOUT consulting the index.
    const dataDir = makeDataDirWithIndex([
      JSON.stringify({
        type: "capability.audited",
        data: {
          rootRunId: "root-session-11111111-1111-4111-8111-111111111111-a1-default:agent:a1:u:c",
          runId: "WRONG-FROM-INDEX",
        },
      }),
    ]);
    const resolved = await resolveRootRunToSession(
      dataDir,
      "root-session-11111111-1111-4111-8111-111111111111-a1-default:agent:a1:u:c",
    );
    expect(resolved).toBe("default:agent:a1:u:c");
  });
});
