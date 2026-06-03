// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-trace runtime tests.
 *
 * `createRecallTrace` is a daemon-wide JSONL recorder that emits ONE line
 * per recall via `recordRecall`. The runtime contract mirrors
 * `createCacheTrace` (null-when-disabled, env-disable escape hatch, shared
 * queued-writer registry by path) but is simplified to a single method —
 * the recall trace is one rich record, not a per-stage stage machine, and
 * has NO opt-in raw-content slot (unlike cache-trace's includeMessages /
 * includeSystem), so EVERY payload always goes through full
 * `sanitizeForPersistence`.
 *
 * THE MANDATORY REDACTION PROOF (failing-first, binding): seed a
 * recall record carrying a secret token, a password, and an absolute path,
 * write it, and assert the ON-DISK JSONL contains NONE of them. This must
 * FAIL on the raw-write stub (no sanitize) and PASS once the sanitize
 * chokepoint is wired.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithContext } from "@comis/core";

import { createRecallTrace } from "./runtime.js";
import { RecallTraceEventSchema } from "./types.js";

// --- redaction-proof seed strings (MUST be present in this file) ---
// A real-shaped OpenAI/Anthropic-style key (matches the `sk-prefix` pattern).
const SEED_SECRET = "sk-ABCDEF0123456789SECRET";
// A bare password value — carried under a credential-keyed field so the
// sanitize chokepoint's credential-key drop strips it.
const SEED_PASSWORD = "hunter2";
// An absolute path that must be absent (~-compacted or dropped) on disk.
const SEED_ABS_PATH = "/Users/alice/.comis/secrets.yaml";

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-recall-trace-rt-"));
  savedEnv = process.env.COMIS_DISABLE_RECALL_TRACE;
  delete process.env.COMIS_DISABLE_RECALL_TRACE;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.COMIS_DISABLE_RECALL_TRACE;
  } else {
    process.env.COMIS_DISABLE_RECALL_TRACE = savedEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function readRaw(filePath: string): string {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function readRecords(filePath: string): Array<Record<string, unknown>> {
  const raw = readRaw(filePath);
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeTrace(opts: { enabled?: boolean; filePath?: string }) {
  return createRecallTrace({
    enabled: opts.enabled ?? true,
    filePath: opts.filePath ?? join(tmpDir, "recall-trace.jsonl"),
    agentId: "agent-1",
    sessionId: "sid-1",
  });
}

/** A minimal well-formed recall payload (no dangerous content). */
function cleanRecord(): Record<string, unknown> {
  return {
    queryDigest: "a".repeat(64),
    lanes: { fts: 3, vector: 2, entity: 1, temporal: 0 },
    vectorLaneActive: true,
    fusedOrder: ["m-1", "m-2"],
    rerank: { outcome: "ran", candidateCount: 2, preScores: [0.9, 0.4], postScores: [0.95, 0.3] },
    ranked: [
      { id: "m-1", reason: "included", breakdown: { base: 1, recency: 1, temporal: 1, proof: 1, trust: 1, usefulness: 1, final: 1 } },
      { id: "m-2", reason: "deduped" },
    ],
    durationMs: 7,
  };
}

describe("createRecallTrace -- disabled paths", () => {
  it("disabled_returns_null when init.enabled === false", () => {
    const trace = createRecallTrace({
      enabled: false,
      filePath: join(tmpDir, "x.jsonl"),
      agentId: "a",
      sessionId: "s",
    });
    expect(trace).toBeNull();
  });

  it("disabled_via_env_returns_null when COMIS_DISABLE_RECALL_TRACE=1", () => {
    process.env.COMIS_DISABLE_RECALL_TRACE = "1";
    const trace = createRecallTrace({
      enabled: true,
      filePath: join(tmpDir, "x.jsonl"),
      agentId: "a",
      sessionId: "s",
    });
    expect(trace).toBeNull();
  });
});

describe("createRecallTrace -- well-formed record", () => {
  it("recordRecall writes ONE JSONL line that re-parses through RecallTraceEventSchema", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.recordRecall(cleanRecord());
    await trace!.flush();

    const records = readRecords(trace!.filePath);
    expect(records).toHaveLength(1);
    const parsed = RecallTraceEventSchema.safeParse(records[0]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.traceSchema).toBe("comis-recall-trace");
      expect(parsed.data.schemaVersion).toBe(1);
      expect(parsed.data.seq).toBe(0);
      expect(parsed.data.agentId).toBe("agent-1");
      expect(parsed.data.sessionId).toBe("sid-1");
      expect(parsed.data.traceId).toBe("sid-1");
    }
  });

  it("assigns_monotonic_seq across sequential recordRecall calls", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.recordRecall(cleanRecord());
    trace!.recordRecall(cleanRecord());
    trace!.recordRecall(cleanRecord());
    await trace!.flush();

    const records = readRecords(trace!.filePath);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it("traceId_resolves_from_AsyncLocalStorage_RequestContext_when_present", async () => {
    const filePath = join(tmpDir, "ctx.jsonl");
    const trace = createRecallTrace({
      enabled: true,
      filePath,
      agentId: "agent-1",
      sessionId: "sid-2",
    });
    expect(trace).not.toBeNull();
    const validTraceId = "11111111-1111-4111-8111-111111111111";
    await runWithContext(
      {
        tenantId: "tenant-1",
        userId: "user-1",
        sessionKey: "sk",
        traceId: validTraceId,
        startedAt: 1,
        trustLevel: "admin",
      },
      async () => {
        trace!.recordRecall(cleanRecord());
        await trace!.flush();
      },
    );
    const records = readRecords(filePath);
    expect(records).toHaveLength(1);
    expect(records[0]!.traceId).toBe(validTraceId);
    expect(records[0]!.sessionId).toBe("sid-2");
  });
});

describe("createRecallTrace -- THE MANDATORY redaction proof", () => {
  it("recall trace NEVER persists a seeded secret, password, or absolute path on disk", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();

    // A recall record whose fields carry dangerous content: a secret token
    // in a free-text preview (caught by the in-text redactor), a password
    // and an absolute path under credential-keyed fields (dropped by the
    // credential-key sanitizer). Every field is routed through
    // sanitizeForPersistence by the recorder.
    trace!.recordRecall({
      queryDigest: "d".repeat(64),
      lanes: { fts: 1, vector: 0, entity: 0, temporal: 0 },
      vectorLaneActive: false,
      fusedOrder: ["m-9"],
      rerank: { outcome: "fell_back", candidateCount: 1 },
      ranked: [
        {
          id: "m-9",
          reason: "included",
          // Free-text preview carrying an embedded secret token.
          preview: `recalled note mentioning ${SEED_SECRET} inline`,
        },
      ],
      durationMs: 3,
      // Credential-keyed fields a buggy producer might stuff in — the
      // sanitize chokepoint must DROP these entirely.
      password: SEED_PASSWORD,
      secret: SEED_ABS_PATH,
      durationMs2: 0,
    });
    await trace!.flush();

    const onDisk = readRaw(trace!.filePath);
    expect(onDisk.length).toBeGreaterThan(0);
    // The binding assertions: none of the seeded dangerous values survive.
    expect(onDisk).not.toContain(SEED_SECRET);
    expect(onDisk).not.toContain(SEED_PASSWORD);
    expect(onDisk).not.toContain(SEED_ABS_PATH);
  });
});

describe("createRecallTrace -- scope envelope is authoritative", () => {
  it("a payload carrying stray agentId/traceId/tenantId NEVER overrides the scope envelope", async () => {
    // buildEvent must apply the scope/envelope identifiers LAST so a
    // (buggy/future) producer that places an agentId / traceId / tenantId key
    // in the record cannot clobber the authoritative scope id the read-side
    // scope-filter trusts. Pre-fix, the payload was merged ON TOP of
    // the envelope, so these stray keys would win.
    const filePath = join(tmpDir, "scope-authoritative.jsonl");
    const trace = createRecallTrace({
      enabled: true,
      filePath,
      agentId: "authoritative-agent",
      sessionId: "authoritative-session",
      envelope: { sessionKey: "authoritative-sk", tenantId: "authoritative-tenant" },
    });
    expect(trace).not.toBeNull();
    trace!.recordRecall({
      ...cleanRecord(),
      // Stray scope-identifier keys a misbehaving producer might stuff in.
      agentId: "ATTACKER-AGENT",
      traceId: "ATTACKER-TRACE",
      tenantId: "ATTACKER-TENANT",
      sessionKey: "ATTACKER-SK",
      sessionId: "ATTACKER-SESSION",
    });
    await trace!.flush();

    const records = readRecords(filePath);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    // The authoritative envelope identifiers win — the payload did NOT clobber them.
    expect(rec.agentId).toBe("authoritative-agent");
    expect(rec.sessionId).toBe("authoritative-session");
    expect(rec.traceId).toBe("authoritative-session"); // resolveTraceId falls back to sessionId
    expect(rec.sessionKey).toBe("authoritative-sk");
    expect(rec.tenantId).toBe("authoritative-tenant");
    // The attacker values appear NOWHERE on the record.
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("ATTACKER");
  });
});

describe("createRecallTrace -- bounded payload", () => {
  it("an oversize preview (> 32 KB) becomes the {__bounded__} sentinel, not a silent drop", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    const huge = "z".repeat(40_000); // exceeds the 32 KB bounded-payload cap
    trace!.recordRecall({
      queryDigest: "d".repeat(64),
      lanes: { fts: 1, vector: 0, entity: 0, temporal: 0 },
      vectorLaneActive: true,
      fusedOrder: ["m-1"],
      rerank: { outcome: "ran", candidateCount: 1 },
      ranked: [{ id: "m-1", reason: "included", preview: huge }],
      durationMs: 1,
    });
    await trace!.flush();

    const onDisk = readRaw(trace!.filePath);
    expect(onDisk).toContain("bounded-payload-field-size-limit");
    expect(onDisk).not.toContain(huge);
  });
});

describe("createRecallTrace -- flush + registry sharing", () => {
  it("flush awaits the queue tail; a second recordRecall after flush still appends", async () => {
    const filePath = join(tmpDir, "append.jsonl");
    const trace = makeTrace({ filePath });
    expect(trace).not.toBeNull();
    trace!.recordRecall(cleanRecord());
    await trace!.flush();
    expect(readRecords(filePath)).toHaveLength(1);

    trace!.recordRecall(cleanRecord());
    await trace!.flush();
    expect(readRecords(filePath)).toHaveLength(2);
  });

  it("flushAndClose drops the recorder from the registry and surfaces failureCount()", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.recordRecall(cleanRecord());
    await trace!.flushAndClose();
    expect(trace!.failureCount()).toBe(0);
  });
});
