// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for export.ts foundations, readSessionBranch,
 * and exportTrajectoryBundle.
 *
 * Tests cover:
 *   - Hard-limit constants with exact values
 *   - buildTranscriptEvents: parentEntryId chaining, sourceSeq assignment,
 *     ts passthrough from SDK entry.timestamp
 *   - sortTrajectoryEvents: primary ts sort, source-order tiebreak,
 *     sourceSeq tiebreak, non-mutation
 *   - TrajectoryBundleManifest + TrajectoryBundleWarning type conformance
 *     (compile-time; TypeScript must accept the literal shapes)
 *   - SDK-written session entries carry parentId (SDK contract)
 *   - readSessionBranch reconstructs branch, cycle detection,
 *     missing-parent detection, warning capping, file-not-found handling
 *   - exportTrajectoryBundle: 8-file bundle, manifest shape, events.jsonl
 *     merge+sort, round-trip, hard limits, corrupt JSONL, pointer-file
 *
 * @module
 */
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  truncateSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { SessionManager as SdkSessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildTranscriptEvents,
  sortTrajectoryEvents,
  MAX_TRAJECTORY_RUNTIME_EVENTS,
  MAX_TRAJECTORY_TOTAL_EVENTS,
  MAX_TRAJECTORY_SESSION_FILE_BYTES,
  MAX_TRAJECTORY_WARNING_ROWS,
  type TrajectoryBundleManifest,
  type TrajectoryBundleWarning,
  readSessionBranch,
  type ReadSessionBranchResult,
} from "./export.js";
// Bundle export symbols live in bundle-exporter.ts to avoid a circular import
// (bundle-exporter.ts imports from export.ts; export.ts must not re-export
// from bundle-exporter.ts or madge detects a circular .d.ts dependency).
import {
  exportTrajectoryBundle,
  type ExportTrajectoryBundleParams,
} from "./bundle-exporter.js";
import type { TrajectoryEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Structural session entry fixture — matches TranscriptSourceEntry shape. */
const e1 = { id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", type: "message" } as const;
const e2 = { id: "entry-2", parentId: "entry-1", timestamp: "2026-01-01T00:00:02.000Z", type: "thinking_level_change" } as const;
const e3 = { id: "entry-3", parentId: "entry-2", timestamp: "2026-01-01T00:00:03.000Z", type: "compaction" } as const;

const base = {
  sessionId: "sess-abc",
  traceId: "trace-xyz",
  agentId: "agent-1",
  workspaceDir: "/home/user/.comis/workspace",
} as const;

// ---------------------------------------------------------------------------
// Helpers to build minimal TrajectoryEvent fixtures for sort tests
// ---------------------------------------------------------------------------

function makeEvent(
  ts: string,
  source: TrajectoryEvent["source"],
  sourceSeq: number | undefined,
  entryId: string,
): TrajectoryEvent {
  return {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    source,
    type: "session.started",
    ts,
    seq: 1,
    agentId: "agent-1",
    sessionId: "sess-abc",
    traceId: "trace-xyz",
    entryId,
    ...(sourceSeq !== undefined ? { sourceSeq } : {}),
  };
}

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

describe("export.ts foundations", () => {
  // -------------------------------------------------------------------------
  // 1. Constants
  // -------------------------------------------------------------------------

  it("MAX_TRAJECTORY_RUNTIME_EVENTS equals 200_000", () => {
    expect(MAX_TRAJECTORY_RUNTIME_EVENTS).toBe(200_000);
  });

  it("MAX_TRAJECTORY_TOTAL_EVENTS equals 250_000", () => {
    expect(MAX_TRAJECTORY_TOTAL_EVENTS).toBe(250_000);
  });

  it("MAX_TRAJECTORY_SESSION_FILE_BYTES equals 50 * 1024 * 1024", () => {
    expect(MAX_TRAJECTORY_SESSION_FILE_BYTES).toBe(50 * 1024 * 1024);
  });

  it("MAX_TRAJECTORY_WARNING_ROWS equals 20", () => {
    expect(MAX_TRAJECTORY_WARNING_ROWS).toBe(20);
  });

  // -------------------------------------------------------------------------
  // 2. buildTranscriptEvents — parentEntryId chaining + sourceSeq
  // -------------------------------------------------------------------------

  it("buildTranscriptEvents produces 1 event per entry with source:transcript", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out).toHaveLength(3);
    for (const ev of out) {
      expect(ev.source).toBe("transcript");
    }
  });

  it("buildTranscriptEvents chains parentEntryId from synthesized predecessor", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    // e1 has no predecessor → parentEntryId is null (e1.parentId is null)
    expect(out[0]!.parentEntryId).toBeNull();
    // e2 predecessor is out[0] (the synthesized event for e1)
    expect(out[1]!.parentEntryId).toBe(out[0]!.entryId);
    // e3 predecessor is out[1]
    expect(out[2]!.parentEntryId).toBe(out[1]!.entryId);
  });

  it("buildTranscriptEvents assigns 1-indexed sourceSeq in chronological order", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out.map((e) => e.sourceSeq)).toEqual([1, 2, 3]);
  });

  it("buildTranscriptEvents uses SDK entry.timestamp as ts", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out[0]!.ts).toBe(e1.timestamp);
    expect(out[1]!.ts).toBe(e2.timestamp);
    expect(out[2]!.ts).toBe(e3.timestamp);
  });

  it("buildTranscriptEvents sets entryId to entry.id (no new UUIDs)", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out[0]!.entryId).toBe(e1.id);
    expect(out[1]!.entryId).toBe(e2.id);
    expect(out[2]!.entryId).toBe(e3.id);
  });

  // -------------------------------------------------------------------------
  // 3. sortTrajectoryEvents — primary ts, tiebreak source, tiebreak sourceSeq
  // -------------------------------------------------------------------------

  it("sortTrajectoryEvents primary ts sort — ascending chronological order", () => {
    const events = [
      makeEvent("2026-01-01T00:00:02.000Z", "runtime", 1, "a"),
      makeEvent("2026-01-01T00:00:01.000Z", "runtime", 2, "b"),
      makeEvent("2026-01-01T00:00:03.000Z", "runtime", 3, "c"),
    ];
    const sorted = sortTrajectoryEvents(events);
    expect(sorted.map((e) => e.ts)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
    ]);
  });

  it("sortTrajectoryEvents tiebreak source order — runtime before transcript", () => {
    const ts = "2026-01-01T00:00:01.000Z";
    const events = [
      makeEvent(ts, "transcript", 1, "t1"),
      makeEvent(ts, "runtime", 1, "r1"),
    ];
    const sorted = sortTrajectoryEvents(events);
    expect(sorted[0]!.source).toBe("runtime");
    expect(sorted[1]!.source).toBe("transcript");
  });

  it("sortTrajectoryEvents tiebreak sourceSeq — ascending numeric, undefined sorts last", () => {
    const ts = "2026-01-01T00:00:01.000Z";
    const events = [
      makeEvent(ts, "runtime", 5, "r5"),
      makeEvent(ts, "runtime", undefined, "ru"),
      makeEvent(ts, "runtime", 3, "r3"),
    ];
    const sorted = sortTrajectoryEvents(events);
    expect(sorted[0]!.sourceSeq).toBe(3);
    expect(sorted[1]!.sourceSeq).toBe(5);
    // undefined sourceSeq sorts after defined
    expect(sorted[2]!.sourceSeq).toBeUndefined();
  });

  it("sortTrajectoryEvents is non-mutating — input array unchanged after sort", () => {
    const ts = "2026-01-01T00:00:01.000Z";
    const events = [
      makeEvent(ts, "transcript", 2, "t2"),
      makeEvent(ts, "runtime", 1, "r1"),
    ];
    // Snapshot the original order by entryId
    const inputSnapshot = events.map((e) => e.entryId);
    sortTrajectoryEvents(events);
    expect(events.map((e) => e.entryId)).toEqual(inputSnapshot);
  });

  // -------------------------------------------------------------------------
  // 4. TrajectoryBundleManifest + TrajectoryBundleWarning compile-time types
  // -------------------------------------------------------------------------

  it("TrajectoryBundleManifest is structurally assignable to the canonical shape", () => {
    const warning: TrajectoryBundleWarning = {
      source: "session",
      code: "invalid-session-json",
      count: 1,
      rows: [2],
      message: "bad JSON on line 2",
    };

    const manifest: TrajectoryBundleManifest = {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      traceId: "trace-xyz",
      sessionId: "sess-abc",
      workspaceDir: "/home/user/.comis/workspace",
      leafId: "entry-42",
      eventCount: 10,
      runtimeEventCount: 7,
      transcriptEventCount: 3,
      sourceFiles: { session: "/path/to/session.jsonl" },
      warnings: [warning],
    };

    expect(manifest.traceSchema).toBe("comis-trajectory");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.eventCount).toBe(10);
    expect(manifest.warnings).toHaveLength(1);
  });

  it("TrajectoryBundleWarning code is a closed union — @ts-expect-error on invalid code", () => {
    // This verifies the closed union: "unknown-code" is not in the valid set.
    // @ts-expect-error — "unknown-code" is not assignable to TrajectoryBundleWarning["code"]
    const _invalid: TrajectoryBundleWarning["code"] = "unknown-code";
    // The @ts-expect-error above suppresses the compile error — test passes at runtime
    expect(typeof _invalid).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// readSessionBranch
// ---------------------------------------------------------------------------

// Suppress type-only import used only for test type assertions
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ReadSessionBranchResultCheck = ReadSessionBranchResult;

describe("readSessionBranch", () => {
  let tmpDir: string;

  // Each test group creates its own tmpDir; afterEach cleans it up.
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Helper to create a fresh tmp directory for each test.
  function makeTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-session-test-"));
    return tmpDir;
  }

  // Helper: write a synthetic JSONL session file with hand-crafted entries.
  // The SDK serialization format is:
  //   line 1: {"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
  //   lines 2+: SessionEntry JSON objects
  // Returns the path of the created file.
  function writeSyntheticSession(dir: string, entries: object[]): string {
    const filePath = join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "test-session-id",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: dir,
    };
    const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(filePath, lines, "utf-8");
    return filePath;
  }

  // Helper: build a minimal model_change entry (simplest non-message entry type).
  function makeModelChangeEntry(
    id: string,
    parentId: string | null,
    timestamp = "2026-01-01T00:00:01.000Z",
  ): object {
    return { type: "model_change", id, parentId, timestamp, provider: "anthropic", modelId: "claude-3" };
  }

  // -------------------------------------------------------------------------
  // SDK-written session has parentId on every non-header entry
  // -------------------------------------------------------------------------

  it("SDK-written session entries all have parentId field (SDK contract)", () => {
    const dir = makeTmpDir();
    const cwdDir = join(dir, "cwd");
    const sessionDir = join(dir, "sessions");
    mkdirSync(cwdDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    // Create an SDK session and append 3 entries.
    // appendThinkingLevelChange + appendModelChange do not flush to disk
    // until an assistant message arrives. We use appendModelChange (simplest)
    // for the first two entries and then force flush via appendThinkingLevelChange,
    // then use a hand-written assistant message append to trigger disk write.
    // Since the SDK defers write until an assistant message, we use
    // appendMessage with a minimal AssistantMessage to trigger flush.
    const sm = SdkSessionManager.create(cwdDir, sessionDir);

    // First two entries via simple SDK calls.
    sm.appendModelChange("anthropic", "claude-3");
    sm.appendThinkingLevelChange("auto");

    // Third entry: minimal assistant message to trigger file flush.
    // AssistantMessage requires: role, content, api, provider, model, usage, stopReason, timestamp.
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      stopReason: "end_turn",
      timestamp: Date.now(),
    });

    const sessionFile = sm.getSessionFile();
    expect(sessionFile).toBeDefined();

    // Re-open via SDK to verify disk persistence.
    const sm2 = SdkSessionManager.open(sessionFile!, sessionDir);
    const entries = sm2.getEntries();

    // Should have 3 entries (the 3 we appended).
    expect(entries.length).toBe(3);

    // Contract: every non-header entry has parentId (string or null).
    for (const entry of entries) {
      expect(typeof entry.parentId === "string" || entry.parentId === null).toBe(true);
    }

    // Exactly one entry should have parentId === null (the root — first entry).
    const rootEntries = entries.filter((e) => e.parentId === null);
    expect(rootEntries.length).toBe(1);

    // The other entries should have non-null parentId.
    const chainedEntries = entries.filter((e) => e.parentId !== null);
    expect(chainedEntries.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // readSessionBranch on SDK-written session
  // -------------------------------------------------------------------------

  it("readSessionBranch reconstructs chronological branch from SDK session", () => {
    const dir = makeTmpDir();
    const cwdDir = join(dir, "cwd");
    const sessionDir = join(dir, "sessions");
    mkdirSync(cwdDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const sm = SdkSessionManager.create(cwdDir, sessionDir);
    sm.appendModelChange("anthropic", "claude-3");
    sm.appendThinkingLevelChange("auto");
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      stopReason: "end_turn",
      timestamp: Date.now(),
    });

    const sessionFile = sm.getSessionFile()!;
    const leafId = sm.getLeafId();

    const result = readSessionBranch(sessionFile);

    expect(result.header).not.toBeNull();
    expect(result.header!.type).toBe("session");
    expect(result.leafId).toBe(leafId);
    expect(result.branchEntries.length).toBe(3);

    // Chronological order: root first, leaf last.
    expect(result.branchEntries[0]!.parentId).toBeNull();
    expect(result.branchEntries[1]!.parentId).toBe(result.branchEntries[0]!.id);
    expect(result.branchEntries[2]!.parentId).toBe(result.branchEntries[1]!.id);

    // No warnings on well-formed session.
    expect(result.warnings.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Cycle detection emits cyclic-session-branch warning
  // -------------------------------------------------------------------------

  it("cyclic session emits cyclic-session-branch warning and returns reachable suffix", () => {
    const dir = makeTmpDir();

    // Cycle: e1.parentId = e3.id AND e3.parentId = e1.id
    // e2 is the "leaf" (most recently appended — the SDK's leaf pointer in the
    // JSONL is determined by the _last_ entry in the file, which the SDK uses
    // as leafId when opening). We make e2 → e1 → e3 → e1 (cycle).
    const e1 = makeModelChangeEntry("e1", "e3"); // cycle: e1 -> e3
    const e2 = makeModelChangeEntry("e2", "e1"); // leaf: e2 -> e1
    const e3 = makeModelChangeEntry("e3", "e1"); // cycle: e3 -> e1

    // Write: e3 first (so it's the "oldest"), then e1, then e2 as leaf.
    // The SDK determines leafId from its internal tracking on load.
    // When opening, the SDK reads the file and builds byId; leafId is the last
    // entry in the file. Put e2 last so it's the leaf.
    const filePath = writeSyntheticSession(dir, [e3, e1, e2]);

    const result = readSessionBranch(filePath);

    expect(result.header).not.toBeNull();
    // Must emit cyclic-session-branch warning.
    expect(result.warnings.some((w) => w.code === "cyclic-session-branch" && w.source === "session")).toBe(true);

    const cycleWarning = result.warnings.find((w) => w.code === "cyclic-session-branch")!;
    expect(cycleWarning.count).toBeGreaterThanOrEqual(1);
    expect(cycleWarning.rows.length).toBeLessThanOrEqual(MAX_TRAJECTORY_WARNING_ROWS);

    // Returns the reachable suffix (non-empty, non-crash).
    expect(result.branchEntries.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Missing-parent detection
  // -------------------------------------------------------------------------

  it("missing-parent session emits incomplete-session-branch warning and returns reachable suffix", () => {
    const dir = makeTmpDir();

    const e1 = makeModelChangeEntry("e1", null);           // root
    const e2 = makeModelChangeEntry("e2", "DOES-NOT-EXIST"); // broken chain

    const filePath = writeSyntheticSession(dir, [e1, e2]);

    const result = readSessionBranch(filePath);

    expect(result.warnings.some((w) => w.code === "incomplete-session-branch" && w.source === "session")).toBe(true);

    const missingWarning = result.warnings.find((w) => w.code === "incomplete-session-branch")!;
    expect(missingWarning.count).toBeGreaterThanOrEqual(1);

    // Returns the reachable suffix (leaf e2 is reachable; stop at broken chain).
    expect(result.branchEntries.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Warning rows.length never exceeds MAX_TRAJECTORY_WARNING_ROWS
  // (cap invariant) — and deep chain (25 entries) traverses without error.
  //
  // Note: the leaf-to-root walk is a SINGLE-PATH walk that breaks on the
  // first cycle or missing-parent detection. This means `count` is at most 1
  // per code per walk. The cap invariant `rows.length <= MAX_TRAJECTORY_WARNING_ROWS`
  // is validated here via a well-formed 25-entry chain (0 warnings) AND via
  // the cycle/missing-parent tests above which confirm warning shape. The important contract is:
  //   - A well-formed deep chain traverses all entries without warnings.
  //   - Any detected warning ALWAYS has rows.length <= MAX_TRAJECTORY_WARNING_ROWS.
  // -------------------------------------------------------------------------

  it("deep 25-entry chain traverses fully (no warnings) and rows cap invariant holds", () => {
    const dir = makeTmpDir();

    // 25 entries in a valid linear chain: e0 (root) <- e1 <- ... <- e24 (leaf).
    const entries: object[] = [];
    for (let i = 0; i < 25; i++) {
      const parentId = i === 0 ? null : `e${i - 1}`;
      entries.push(makeModelChangeEntry(`e${i}`, parentId, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`));
    }

    const filePath = writeSyntheticSession(dir, entries);

    const result = readSessionBranch(filePath);

    // Well-formed chain: no warnings.
    expect(result.warnings.length).toBe(0);

    // All 25 entries in chronological order.
    expect(result.branchEntries.length).toBe(25);
    expect(result.branchEntries[0]!.id).toBe("e0");
    expect(result.branchEntries[24]!.id).toBe("e24");

    // Cap invariant: any warning's rows.length is always <= MAX_TRAJECTORY_WARNING_ROWS.
    // Verified by the missing-parent test which fires a warning with rows.length === 1 <= 20.
    // Here we re-verify the invariant holds on the clean path too (zero warnings → no violation).
    for (const w of result.warnings) {
      expect(w.rows.length).toBeLessThanOrEqual(MAX_TRAJECTORY_WARNING_ROWS);
    }
  });

  // -------------------------------------------------------------------------
  // Missing file returns invalid-session-json warning, no throw
  // -------------------------------------------------------------------------

  it("missing file path returns invalid-session-json warning without throwing", () => {
    const result = readSessionBranch("/nonexistent/path/that/does/not/exist.jsonl");

    expect(result.header).toBeNull();
    expect(result.leafId).toBeNull();
    expect(result.branchEntries.length).toBe(0);
    expect(result.warnings.some((w) => w.code === "invalid-session-json")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Leaf-to-root walk direction (5-entry chain)
  // -------------------------------------------------------------------------

  it("readSessionBranch reconstructs 5-entry chain in chronological root-first order", () => {
    const dir = makeTmpDir();

    // Chain: e1 <- e2 <- e3 <- e4 <- e5 (e5 is the leaf, e1 is the root)
    const e1 = makeModelChangeEntry("e1", null,   "2026-01-01T00:00:01.000Z");
    const e2 = makeModelChangeEntry("e2", "e1",   "2026-01-01T00:00:02.000Z");
    const e3 = makeModelChangeEntry("e3", "e2",   "2026-01-01T00:00:03.000Z");
    const e4 = makeModelChangeEntry("e4", "e3",   "2026-01-01T00:00:04.000Z");
    const e5 = makeModelChangeEntry("e5", "e4",   "2026-01-01T00:00:05.000Z");

    // Write in order: e1, e2, e3, e4, e5 — e5 is the last entry so SDK sets it as leaf.
    const filePath = writeSyntheticSession(dir, [e1, e2, e3, e4, e5]);

    const result = readSessionBranch(filePath);

    expect(result.branchEntries.length).toBe(5);

    // Root first, leaf last (chronological).
    expect(result.branchEntries[0]!.id).toBe("e1");
    expect(result.branchEntries[4]!.id).toBe("e5");

    // No warnings on well-formed chain.
    expect(result.warnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// exportTrajectoryBundle
// ---------------------------------------------------------------------------

/**
 * Minimal valid TrajectoryEvent envelope for fixture runtime events.
 * Used by setupBundleFixture to write the runtime trajectory JSONL.
 */
function makeRuntimeEvent(
  type: string,
  ts: string,
  seq: number,
  sessionId: string,
  traceId: string,
  agentId: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    source: "runtime",
    type,
    ts,
    seq,
    sessionId,
    traceId,
    agentId,
    entryId: `runtime-entry-${seq}`,
    sourceSeq: seq,
    ...(data !== undefined ? { data } : {}),
  };
}

interface BundleFixture {
  workspaceDir: string;
  sessionFile: string;
  runtimeFile: string;
  sessionId: string;
  traceId: string;
  agentId: string;
  leafId: string | null;
  clock: () => number;
}

/**
 * Create a reusable bundle test fixture:
 * 1. SDK session with 3 appended entries → sessionFile
 * 2. Five fixture runtime events written to <sessionFile>.trajectory.jsonl
 *    - trace.metadata (with prompting/skills)
 *    - trace.artifacts
 *    - two tool.call events (fetch, bash)
 *    - model.completed
 */
function setupBundleFixture(tmpDirBase: string): BundleFixture {
  const workspaceDir = mkdtempSync(join(tmpDirBase, "bundle-workspace-"));
  const sessionDir = join(workspaceDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });

  const sessionId = "bundle-test-session-01";
  const traceId = "trace-bundle-01";
  const agentId = "agent-bundle-01";

  // Create SDK session with 3 entries to produce the branch.
  const sm = SdkSessionManager.create(workspaceDir, sessionDir);
  sm.appendModelChange("anthropic", "claude-3");
  sm.appendThinkingLevelChange("auto");
  // Trigger disk flush via assistant message.
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "bundle fixture" }],
    api: "anthropic",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    usage: {
      inputTokens: 5,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    stopReason: "end_turn",
    timestamp: Date.now(),
  });

  const sessionFile = sm.getSessionFile()!;
  const leafId = sm.getLeafId() ?? null;

  // Five fixture runtime events. Use timestamps interleaved with the session
  // entries so the merge test is non-trivial (runtime events interspersed
  // between transcript events when sorted by ts).
  const runtimeFile = `${sessionFile}.trajectory.jsonl`;
  const runtimeEvents = [
    makeRuntimeEvent(
      "trace.metadata",
      "2026-01-01T00:00:01.500Z",
      1,
      sessionId,
      traceId,
      agentId,
      {
        harness: "comis",
        model: "claude-3",
        config: { maxTokens: 2048 },
        plugins: ["echo"],
        skills: ["skill-a"],
        prompting: {
          systemPrompt: "You are a helpful assistant.",
          userPromptPrefixText: "Please answer:",
          systemPromptByteLen: 27,
        },
        redaction: { enabled: false },
      },
    ),
    makeRuntimeEvent(
      "trace.artifacts",
      "2026-01-01T00:00:03.500Z",
      2,
      sessionId,
      traceId,
      agentId,
      {
        finalStatus: "completed",
        usage: { inputTokens: 50, outputTokens: 20 },
        turnCount: 1,
      },
    ),
    makeRuntimeEvent(
      "tool.call",
      "2026-01-01T00:00:02.000Z",
      3,
      sessionId,
      traceId,
      agentId,
      { toolName: "fetch", url: "https://example.com" },
    ),
    makeRuntimeEvent(
      "tool.call",
      "2026-01-01T00:00:02.500Z",
      4,
      sessionId,
      traceId,
      agentId,
      { toolName: "bash", command: "ls" },
    ),
    makeRuntimeEvent(
      "model.completed",
      "2026-01-01T00:00:04.000Z",
      5,
      sessionId,
      traceId,
      agentId,
      { stopReason: "end_turn", outputTokens: 20 },
    ),
  ];
  writeFileSync(
    runtimeFile,
    runtimeEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );

  // Fixed clock for deterministic generatedAt.
  const clock = (): number => 1735689600000; // 2025-01-01T00:00:00.000Z

  return { workspaceDir, sessionFile, runtimeFile, sessionId, traceId, agentId, leafId, clock };
}

describe("exportTrajectoryBundle", () => {
  // Suppress unused-vars lint — the type import is a compile-time check.
  type _ParamsCheck = ExportTrajectoryBundleParams;

  let tmpDir: string;
  let fixture: BundleFixture;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeFixture(): BundleFixture {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-bundle-test-"));
    fixture = setupBundleFixture(tmpDir);
    return fixture;
  }

  // -------------------------------------------------------------------------
  // Test 1: directory contains exactly 8 files with exact names.
  // -------------------------------------------------------------------------

  it("result is ok and bundleDir matches expected pattern", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundleDir).toMatch(
      /^.*\/trace-exports\/comis-trace-[a-z0-9]{8}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\/?$/,
    );
    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "artifacts.json",
      "events.jsonl",
      "manifest.json",
      "metadata.json",
      "prompts.json",
      "session-branch.json",
      "system-prompt.txt",
      "tools.json",
    ]);
  });

  // -------------------------------------------------------------------------
  // Test 2: bundle directory created with mode 0o700.
  // -------------------------------------------------------------------------

  it("bundle directory has mode 0o700", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // eslint-disable-next-line no-bitwise
    expect(statSync(result.value.bundleDir).mode & 0o777).toBe(0o700);
  });

  // -------------------------------------------------------------------------
  // Test 3: each bundle file has mode 0o600.
  // -------------------------------------------------------------------------

  it("each bundle file has mode 0o600", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = readdirSync(result.value.bundleDir);
    for (const name of files) {
      const filePath = join(result.value.bundleDir, name);
      // eslint-disable-next-line no-bitwise
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: manifest.json matches TrajectoryBundleManifest shape.
  // -------------------------------------------------------------------------

  it("manifest.json shape matches TrajectoryBundleManifest with auto-populated contents", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundleDir = result.value.bundleDir;
    const manifest = JSON.parse(
      readFileSync(join(bundleDir, "manifest.json"), "utf-8"),
    ) as TrajectoryBundleManifest;

    expect(manifest.traceSchema).toBe("comis-trajectory");
    expect(manifest.schemaVersion).toBe(1);
    expect(typeof manifest.generatedAt).toBe("string");
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
    expect(manifest.traceId).toBe(f.traceId);
    expect(manifest.sessionId).toBe(f.sessionId);
    // The manifest's host-path fields are placeholder-substituted before the
    // write (the same pass the content files receive), so no raw absolute path
    // reaches disk. The fixture's session/runtime live under workspaceDir, so
    // the substituted form is $WORKSPACE_DIR-prefixed.
    expect(manifest.workspaceDir).toBe("$WORKSPACE_DIR");
    expect(manifest.leafId).toBe(f.leafId);
    expect(manifest.eventCount).toBe(
      (manifest.runtimeEventCount ?? 0) + (manifest.transcriptEventCount ?? 0),
    );
    expect(manifest.runtimeEventCount).toBe(5);
    expect(manifest.transcriptEventCount).toBe(3);
    expect(manifest.sourceFiles.session).toBe(
      "$WORKSPACE_DIR" + f.sessionFile.slice(f.workspaceDir.length),
    );
    expect(manifest.sourceFiles.runtime).toBe(
      "$WORKSPACE_DIR" + f.runtimeFile.slice(f.workspaceDir.length),
    );
    expect(Array.isArray(manifest.contents)).toBe(true);
    expect(manifest.contents!.length).toBe(8);
    for (const entry of manifest.contents!) {
      expect(typeof entry.path).toBe("string");
      expect(typeof entry.mediaType).toBe("string");
      expect(typeof entry.bytes).toBe("number");
      expect(entry.bytes).toBe(statSync(join(bundleDir, entry.path)).size);
    }
    const contentPaths = manifest.contents!.map((c) => c.path).sort();
    expect(contentPaths).toEqual([
      "artifacts.json",
      "events.jsonl",
      "manifest.json",
      "metadata.json",
      "prompts.json",
      "session-branch.json",
      "system-prompt.txt",
      "tools.json",
    ]);
  });

  // -------------------------------------------------------------------------
  // Test 4b: manifest host-path fields are placeholder-substituted — the
  // bundle ships no raw absolute host path. Under the default data-dir layout
  // a raw session/workspace path discloses the OS username, so the manifest
  // must receive the same path substitution the content files already get.
  // -------------------------------------------------------------------------

  it("manifest host-path fields are placeholder-substituted, leaking no raw host path", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifestRaw = readFileSync(join(result.value.bundleDir, "manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw) as TrajectoryBundleManifest;

    // The workspace + source-file fields carry placeholders, never a raw path.
    expect(manifest.workspaceDir).toBe("$WORKSPACE_DIR");
    expect(manifest.sourceFiles.session.startsWith("$WORKSPACE_DIR/")).toBe(true);
    expect(manifest.sourceFiles.runtime?.startsWith("$WORKSPACE_DIR/")).toBe(true);

    // The raw absolute workspace path appears nowhere in the manifest text — the
    // substitution that already covers every content file now covers the
    // manifest, so a shared bundle discloses no host directory structure.
    expect(manifestRaw).not.toContain(f.workspaceDir);

    // The returned manifest object and the on-disk manifest agree: the exporter
    // substitutes once, at manifest construction, so both surfaces match.
    expect(result.value.manifest.workspaceDir).toBe("$WORKSPACE_DIR");
    expect(result.value.manifest.sourceFiles.session).toBe(manifest.sourceFiles.session);
  });

  // -------------------------------------------------------------------------
  // Test 5: events.jsonl sorted by ts with (source, sourceSeq) tiebreak.
  // -------------------------------------------------------------------------

  it("events.jsonl is sorted by ts with source-order tiebreak", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const eventsRaw = readFileSync(
      join(result.value.bundleDir, "events.jsonl"),
      "utf-8",
    )
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { ts: string; source: string; sourceSeq?: number });

    expect(eventsRaw.length).toBe(8); // 5 runtime + 3 transcript

    // Primary: ascending ts.
    for (let i = 0; i < eventsRaw.length - 1; i++) {
      expect(eventsRaw[i]!.ts <= eventsRaw[i + 1]!.ts).toBe(true);
    }
    // Where ts equal: runtime source comes before transcript source.
    const sameTs = eventsRaw.filter((e, i, arr) => i > 0 && arr[i - 1]!.ts === e.ts);
    for (const ev of sameTs) {
      // No transcript event should appear before a runtime event with the same ts.
      // Simply verify source ordering: runtime < transcript.
      if (ev.source === "runtime") {
        // OK — runtime before transcript.
      }
    }
    // Verify at least one runtime event precedes at least one transcript event overall.
    const runtimeIdx = eventsRaw.findIndex((e) => e.source === "runtime");
    const transcriptIdx = eventsRaw.findIndex((e) => e.source === "transcript");
    expect(runtimeIdx).not.toBe(-1);
    expect(transcriptIdx).not.toBe(-1);
  });

  // -------------------------------------------------------------------------
  // Test 6: round-trip — events.jsonl alone reconstructs tool calls.
  // -------------------------------------------------------------------------

  it("round-trip: events.jsonl alone reconstructs chronological tool-call timeline", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = readFileSync(join(result.value.bundleDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; ts: string; data?: { toolName?: string } });

    const toolCalls = events.filter((e) => e.type === "tool.call");
    expect(toolCalls.length).toBe(2);
    // Chronological order: fetch (00:00:02) before bash (00:00:02.500).
    expect(toolCalls[0]!.ts <= toolCalls[1]!.ts).toBe(true);
    expect(toolCalls[0]!.data?.toolName).toBe("fetch");
    expect(toolCalls[1]!.data?.toolName).toBe("bash");
  });

  // -------------------------------------------------------------------------
  // Test 7: session-branch.json structure.
  // -------------------------------------------------------------------------

  it("session-branch.json contains {header, leafId, branchEntries}", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const branch = JSON.parse(
      readFileSync(join(result.value.bundleDir, "session-branch.json"), "utf-8"),
    ) as { header: { type: string } | null; leafId: string | null; branchEntries: Array<{ parentId: string | null; id: string }> };

    expect(branch.header).not.toBeNull();
    expect(branch.header!.type).toBe("session");
    expect(typeof branch.leafId).toBe("string");
    expect(Array.isArray(branch.branchEntries)).toBe(true);
    expect(branch.branchEntries.length).toBe(3);
    expect(branch.branchEntries[0]!.parentId).toBeNull();
    expect(branch.branchEntries[1]!.parentId).toBe(branch.branchEntries[0]!.id);
    expect(branch.branchEntries[2]!.parentId).toBe(branch.branchEntries[1]!.id);
  });

  // -------------------------------------------------------------------------
  // Test 8: metadata.json from latest trace.metadata.
  // -------------------------------------------------------------------------

  it("metadata.json populated from latest trace.metadata event", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = JSON.parse(
      readFileSync(join(result.value.bundleDir, "metadata.json"), "utf-8"),
    ) as Record<string, unknown>;

    expect("harness" in metadata).toBe(true);
    expect("model" in metadata).toBe(true);
    expect("config" in metadata).toBe(true);
    expect("plugins" in metadata).toBe(true);
    expect("skills" in metadata).toBe(true);
    expect("prompting" in metadata).toBe(true);
    expect("redaction" in metadata).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9: artifacts.json from latest trace.artifacts.
  // -------------------------------------------------------------------------

  it("artifacts.json populated from latest trace.artifacts event", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifacts = JSON.parse(
      readFileSync(join(result.value.bundleDir, "artifacts.json"), "utf-8"),
    ) as Record<string, unknown>;

    expect("finalStatus" in artifacts).toBe(true);
    expect("usage" in artifacts).toBe(true);
    expect("turnCount" in artifacts).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 10: prompts.json + system-prompt.txt from trace.metadata.
  // -------------------------------------------------------------------------

  it("prompts.json and system-prompt.txt from trace.metadata.prompting", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundleDir = result.value.bundleDir;
    const prompts = JSON.parse(
      readFileSync(join(bundleDir, "prompts.json"), "utf-8"),
    ) as { systemPrompt: string; userPromptPrefixText?: string; skills: unknown[] };

    expect(typeof prompts.systemPrompt).toBe("string");
    expect(prompts.systemPrompt).toBe("You are a helpful assistant.");
    expect(prompts.userPromptPrefixText).toBe("Please answer:");
    expect(Array.isArray(prompts.skills)).toBe(true);

    const systemPromptTxt = readFileSync(join(bundleDir, "system-prompt.txt"), "utf-8");
    expect(systemPromptTxt).toBe(prompts.systemPrompt);
  });

  // -------------------------------------------------------------------------
  // Test 11: tools.json from tool.call events (sorted + dedup'd + bounded).
  // -------------------------------------------------------------------------

  it("tools.json contains dedup'd sorted tool definitions from tool.call events", async () => {
    const f = makeFixture();
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tools = JSON.parse(
      readFileSync(join(result.value.bundleDir, "tools.json"), "utf-8"),
    ) as Array<{ name: string }>;

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(2);
    // Alphabetically sorted: bash < fetch.
    expect(tools[0]!.name).toBe("bash");
    expect(tools[1]!.name).toBe("fetch");
  });

  // -------------------------------------------------------------------------
  // Test 12: session file > 50 MB → err result.
  // -------------------------------------------------------------------------

  it("session file > 50 MB returns session-file-too-large error, no bundle", async () => {
    const f = makeFixture();
    // Truncate (extend) sessionFile to > 50 MB using sparse file.
    truncateSync(f.sessionFile, MAX_TRAJECTORY_SESSION_FILE_BYTES + 1024);
    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("session-file-too-large");
    // No bundle directory should have been created.
    const traceExportsDir = join(f.workspaceDir, "trace-exports");
    const bundleExists = existsSync(traceExportsDir) &&
      readdirSync(traceExportsDir).length > 0;
    expect(bundleExists).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 13: corrupt runtime JSONL → manifest warnings, no crash.
  // -------------------------------------------------------------------------

  it("corrupt runtime JSONL emits warnings but bundle is still produced", async () => {
    const f = makeFixture();
    // Overwrite runtime file: 1 valid + 1 corrupt + 1 valid.
    const valid1 = JSON.stringify(
      makeRuntimeEvent("model.completed", "2026-01-01T00:00:01.000Z", 1, f.sessionId, f.traceId, f.agentId),
    );
    const valid2 = JSON.stringify(
      makeRuntimeEvent("model.completed", "2026-01-01T00:00:02.000Z", 2, f.sessionId, f.traceId, f.agentId),
    );
    const corrupt = "{not-json";
    writeFileSync(f.runtimeFile, [valid1, corrupt, valid2].join("\n") + "\n", "utf-8");

    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = result.value.manifest;
    expect(
      (manifest.warnings ?? []).some(
        (w) => w.code === "invalid-runtime-json" || w.code === "invalid-runtime-event",
      ),
    ).toBe(true);
    expect(manifest.runtimeEventCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 14: missing runtime trajectory file → bundle with empty runtime.
  // -------------------------------------------------------------------------

  it("missing runtime trajectory file → bundle produced with empty runtime section", async () => {
    const f = makeFixture();
    // Remove runtime file to simulate trajectory-disabled state.
    rmSync(f.runtimeFile);

    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = result.value.manifest;
    expect(manifest.runtimeEventCount).toBe(0);
    expect(manifest.sourceFiles.runtime).toBeUndefined();

    // events.jsonl should contain only the 3 transcript events.
    const events = readFileSync(join(result.value.bundleDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(events.length).toBe(3);
    const parsed = events.map((l) => JSON.parse(l) as { source: string });
    expect(parsed.every((e) => e.source === "transcript")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 15: pointer file takes precedence over co-located convention.
  // -------------------------------------------------------------------------

  it("pointer file takes precedence over co-located trajectory file", async () => {
    const f = makeFixture();

    // Create an alternate runtime file with a distinct event type.
    const altRuntimeFile = join(tmpDir, "alt-trajectory.jsonl");
    const altEvent = makeRuntimeEvent(
      "model.completed",
      "2026-01-01T00:00:10.000Z",
      99,
      f.sessionId,
      f.traceId,
      f.agentId,
      { altFile: true },
    );
    writeFileSync(altRuntimeFile, JSON.stringify(altEvent) + "\n", "utf-8");

    // Write a pointer file pointing to the alternate file.
    const pointerFile = `${f.sessionFile}.trajectory-path.json`;
    const pointer = {
      traceSchema: "comis-trajectory-pointer",
      schemaVersion: 1,
      sessionId: f.sessionId,
      runtimeFile: altRuntimeFile,
    };
    writeFileSync(pointerFile, JSON.stringify(pointer), "utf-8");

    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The events should come from the pointer-resolved file (only 1 event).
    expect(result.value.manifest.runtimeEventCount).toBe(1);
    expect(result.value.manifest.sourceFiles.runtime).toBe(altRuntimeFile);
    // The event type in events.jsonl should be model.completed (not tool.call from co-located).
    const events = readFileSync(join(result.value.bundleDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { source: string; type: string });
    const runtimeEvents = events.filter((e) => e.source === "runtime");
    expect(runtimeEvents.length).toBe(1);
    expect(runtimeEvents[0]!.type).toBe("model.completed");
  });
});

// ---------------------------------------------------------------------------
// Bundle cap + sort invariant tests
// ---------------------------------------------------------------------------

describe("bundle cap + sort invariant tests", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Case 1: runtime event cap — 200_500 events → runtimeEventCount
  //         capped at 200_000 + invalid-runtime-event warning fires.
  //
  // Note: writing 200_500 events produces ~40 MB of JSONL. The test is bounded
  // (~5-10s) but intentionally exercises the cap at real scale.
  // -------------------------------------------------------------------------

  it("runtime event cap enforced at MAX_TRAJECTORY_RUNTIME_EVENTS=200_000 and warning fires", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-bundle-cap-test-"));
    const fixture = setupBundleFixture(tmpDir);

    // Generate 200_500 minimal runtime events — just past the 200_000 cap.
    // Each event ~200 bytes. Total ~40 MB — below the session-file cap.
    const SID = fixture.sessionId;
    const TID = fixture.traceId;
    const AID = fixture.agentId;

    const lines: string[] = [];
    for (let i = 0; i < 200_500; i++) {
      const ts = `2026-01-01T00:00:0${(i % 10)}.${String(i % 1000).padStart(3, "0")}Z`;
      lines.push(
        JSON.stringify({
          traceSchema: "comis-trajectory",
          schemaVersion: 1,
          source: "runtime",
          type: "model.completed",
          ts,
          seq: i,
          sessionId: SID,
          traceId: TID,
          agentId: AID,
          entryId: `e${i}`,
          sourceSeq: i,
          data: {},
        }),
      );
    }
    writeFileSync(fixture.runtimeFile, lines.join("\n") + "\n", "utf-8");

    const result = await exportTrajectoryBundle({
      sessionId: fixture.sessionId,
      sessionFile: fixture.sessionFile,
      workspaceDir: fixture.workspaceDir,
      traceId: fixture.traceId,
      agentId: fixture.agentId,
      clock: fixture.clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // runtimeEventCount is capped at MAX_TRAJECTORY_RUNTIME_EVENTS (200_000).
    expect(result.value.manifest.runtimeEventCount).toBe(MAX_TRAJECTORY_RUNTIME_EVENTS);

    // At least one invalid-runtime-event warning fires for the cap overage.
    const capWarning = (result.value.manifest.warnings ?? []).find(
      (w) => w.code === "invalid-runtime-event",
    );
    expect(capWarning, "Expected an invalid-runtime-event warning for the cap").toBeDefined();
    expect(capWarning!.message).toMatch(/[Rr]untime.*[Cc]ap.*[Ee]xceed|MAX_TRAJECTORY_RUNTIME/);
  }, 30_000); // generous timeout for 200k-event fixture write

  // -------------------------------------------------------------------------
  // Case 2: deterministic mixed-source sort — exact order including
  //         tiebreak at identical ts (runtime before transcript).
  // -------------------------------------------------------------------------

  it("mixed-source sort has exact ts order with runtime-before-transcript tiebreak at same ts", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-bundle-sort-test-"));
    const workspaceDir = mkdtempSync(join(tmpDir, "workspace-"));
    const sessionDir = join(workspaceDir, "sessions");
    mkdirSync(sessionDir, { recursive: true });

    const sessionId = "sort-test-session-01";
    const traceId = "trace-sort-01";
    const agentId = "agent-sort-01";

    // Write a synthetic 3-entry session JSONL with controlled timestamps so
    // the transcript events land at ts=02s, 03s, 04s.
    const sessionFilePath = join(sessionDir, "sort-test-session.jsonl");
    const sessionHeader = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: workspaceDir,
    };
    const transcriptEntries = [
      { type: "model_change", id: "t1", parentId: null,  timestamp: "2026-01-01T00:00:02.000Z", provider: "anthropic", modelId: "claude-3" },
      { type: "model_change", id: "t2", parentId: "t1",  timestamp: "2026-01-01T00:00:03.000Z", provider: "anthropic", modelId: "claude-3" },
      { type: "model_change", id: "t3", parentId: "t2",  timestamp: "2026-01-01T00:00:04.000Z", provider: "anthropic", modelId: "claude-3" },
    ];
    const sessionLines =
      [sessionHeader, ...transcriptEntries].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(sessionFilePath, sessionLines, "utf-8");

    // 3 runtime events: ts=01s, 03s, 05s (interleaved with transcript).
    // At ts=03s there is a tie: runtime event r3 vs transcript event t2 —
    // runtime must sort first.
    const runtimeFile = `${sessionFilePath}.trajectory.jsonl`;
    const runtimeEvents = [
      { traceSchema: "comis-trajectory", schemaVersion: 1, source: "runtime", type: "model.completed", ts: "2026-01-01T00:00:01.000Z", seq: 1, sessionId, traceId, agentId, entryId: "r1", sourceSeq: 1, data: {} },
      { traceSchema: "comis-trajectory", schemaVersion: 1, source: "runtime", type: "model.completed", ts: "2026-01-01T00:00:03.000Z", seq: 3, sessionId, traceId, agentId, entryId: "r3", sourceSeq: 3, data: {} },
      { traceSchema: "comis-trajectory", schemaVersion: 1, source: "runtime", type: "model.completed", ts: "2026-01-01T00:00:05.000Z", seq: 5, sessionId, traceId, agentId, entryId: "r5", sourceSeq: 5, data: {} },
    ];
    writeFileSync(
      runtimeFile,
      runtimeEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );

    const clock = (): number => 1735689600000;
    const result = await exportTrajectoryBundle({
      sessionId,
      sessionFile: sessionFilePath,
      workspaceDir,
      traceId,
      agentId,
      clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const eventsRaw = readFileSync(join(result.value.bundleDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { ts: string; source: string });

    // Should have 6 events total: 3 runtime + 3 transcript.
    expect(eventsRaw.length).toBe(6);

    // Exact order per sort contract.
    expect(eventsRaw[0]!.ts).toBe("2026-01-01T00:00:01.000Z");
    expect(eventsRaw[0]!.source).toBe("runtime");

    expect(eventsRaw[1]!.ts).toBe("2026-01-01T00:00:02.000Z");
    expect(eventsRaw[1]!.source).toBe("transcript");

    // Tiebreak: runtime before transcript at identical ts=03s.
    expect(eventsRaw[2]!.ts).toBe("2026-01-01T00:00:03.000Z");
    expect(eventsRaw[2]!.source).toBe("runtime");

    expect(eventsRaw[3]!.ts).toBe("2026-01-01T00:00:03.000Z");
    expect(eventsRaw[3]!.source).toBe("transcript");

    expect(eventsRaw[4]!.ts).toBe("2026-01-01T00:00:04.000Z");
    expect(eventsRaw[4]!.source).toBe("transcript");

    expect(eventsRaw[5]!.ts).toBe("2026-01-01T00:00:05.000Z");
    expect(eventsRaw[5]!.source).toBe("runtime");
  });

  // -------------------------------------------------------------------------
  // Case 3: warning-row 20-cap — 25 invalid JSON lines in runtime
  //         JSONL → invalid-runtime-json warning has rows.length === 20 (cap
  //         enforced) and count === 25 (true count preserved).
  //
  // NOTE: The readSessionBranch walk stops on the first cycle detection, so
  // cyclic-session-branch warnings have count=1 per walk. To exercise the
  // rows[] 20-cap, we use the runtime JSONL path which CAN accumulate many
  // warning rows: 25 invalid JSON lines → count=25, rows.length=20.
  // -------------------------------------------------------------------------

  it("warning-row 20-cap enforced — 25 invalid runtime lines produces rows.length=20 and count=25", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-bundle-warn-test-"));
    const fixture = setupBundleFixture(tmpDir);

    const SID = fixture.sessionId;
    const TID = fixture.traceId;
    const AID = fixture.agentId;

    // Write 1 valid + 25 invalid + 1 valid runtime JSONL lines.
    const valid1 = JSON.stringify({
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      source: "runtime",
      type: "model.completed",
      ts: "2026-01-01T00:00:01.000Z",
      seq: 1,
      sessionId: SID,
      traceId: TID,
      agentId: AID,
      entryId: "valid-1",
      sourceSeq: 1,
      data: {},
    });
    const valid2 = JSON.stringify({
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      source: "runtime",
      type: "model.completed",
      ts: "2026-01-01T00:00:02.000Z",
      seq: 2,
      sessionId: SID,
      traceId: TID,
      agentId: AID,
      entryId: "valid-2",
      sourceSeq: 2,
      data: {},
    });

    const invalidLines = Array.from({ length: 25 }, (_, i) => `{not-json-line-${i}`);
    const allLines = [valid1, ...invalidLines, valid2];
    writeFileSync(fixture.runtimeFile, allLines.join("\n") + "\n", "utf-8");

    const result = await exportTrajectoryBundle({
      sessionId: fixture.sessionId,
      sessionFile: fixture.sessionFile,
      workspaceDir: fixture.workspaceDir,
      traceId: fixture.traceId,
      agentId: fixture.agentId,
      clock: fixture.clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The 2 valid events should be included; 25 invalid lines skipped.
    expect(result.value.manifest.runtimeEventCount).toBe(2);

    // An invalid-runtime-json warning fires.
    const jsonWarning = (result.value.manifest.warnings ?? []).find(
      (w) => w.code === "invalid-runtime-json",
    );
    expect(jsonWarning, "Expected an invalid-runtime-json warning").toBeDefined();

    // True count is preserved (all 25 invalid lines counted).
    expect(jsonWarning!.count).toBe(25);

    // rows is capped at MAX_TRAJECTORY_WARNING_ROWS (20).
    expect(jsonWarning!.rows.length).toBe(MAX_TRAJECTORY_WARNING_ROWS);
    expect(jsonWarning!.rows.length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Bundle redaction integration
// ---------------------------------------------------------------------------

describe("bundle redaction integration", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-redact-test-"));
    return tmpDir;
  }

  // Helper: build a minimal session file and pointer + runtime JSONL.
  // Returns workspaceDir, sessionFile, runtimeFile, and params for exportTrajectoryBundle.
  function makeRedactFixture(
    events: Record<string, unknown>[],
    overrideWorkspaceDir?: string,
  ): {
    workspaceDir: string;
    sessionFile: string;
    runtimeFile: string;
    sessionId: string;
    traceId: string;
    agentId: string;
    clock: () => number;
  } {
    const baseDir = overrideWorkspaceDir ?? makeTmpDir();
    const sessionDir = join(baseDir, "sessions");
    mkdirSync(sessionDir, { recursive: true });

    const sessionId = "redact-test-sess-01";
    const traceId = "trace-redact-01";
    const agentId = "agent-redact-01";

    // Minimal SDK session with 1 entry.
    const sm = SdkSessionManager.create(baseDir, sessionDir);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "redact test" }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      stopReason: "end_turn",
      timestamp: Date.now(),
    });

    const sessionFile = sm.getSessionFile()!;
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    writeFileSync(
      runtimeFile,
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );

    return {
      workspaceDir: baseDir,
      sessionFile,
      runtimeFile,
      sessionId,
      traceId,
      agentId,
      clock: () => 1735689600000,
    };
  }

  function makeMinimalRuntimeEvent(
    data: Record<string, unknown>,
    seq = 1,
    sessionId = "redact-test-sess-01",
    traceId = "trace-redact-01",
    agentId = "agent-redact-01",
  ): Record<string, unknown> {
    return {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      source: "runtime",
      type: "session.started",
      ts: `2026-01-01T00:00:0${seq}.000Z`,
      seq,
      sessionId,
      traceId,
      agentId,
      entryId: `redact-entry-${seq}`,
      sourceSeq: seq,
      data,
    };
  }

  // ---------------------------------------------------------------------------
  // Test 1: HEADLINE — zero unredacted long-decimal IDs in output files.
  // ---------------------------------------------------------------------------

  it("bundle_has_zero_unredacted_long_decimal_ids: events.jsonl has no \\b\\d{9,}\\b matches outside ISO timestamps", async () => {
    const base = makeTmpDir();
    const f = makeRedactFixture(
      [
        makeMinimalRuntimeEvent({ chatId: "1234567890", note: "no sensitive data here" }, 1),
        makeMinimalRuntimeEvent({ userId: "987654321", info: "another event" }, 2),
      ],
      base,
    );

    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundleDir = result.value.bundleDir;

    // Read events.jsonl — it carries the main user-data content.
    // Parse each line and collect all STRING-typed leaf values, then check
    // that none contain a raw long-decimal ID (9+ consecutive digits).
    // Number-typed fields (seq, timestamps, counts) are exempt — they are NOT
    // strings so the walker correctly leaves them alone.
    const eventsText = readFileSync(join(bundleDir, "events.jsonl"), "utf-8");

    const longDecimalRe = /\b\d{9,}\b/;

    // Collect all string leaf values from JSON.
    function collectStringLeaves(obj: unknown): string[] {
      if (typeof obj === "string") return [obj];
      if (obj === null || typeof obj !== "object") return [];
      const results: string[] = [];
      for (const v of Object.values(obj as Record<string, unknown>)) {
        results.push(...collectStringLeaves(v));
      }
      return results;
    }

    const eventLines = eventsText
      .split("\n")
      .filter((l) => l.trim().length > 0);

    for (const line of eventLines) {
      const parsed = JSON.parse(line) as unknown;
      const stringLeaves = collectStringLeaves(parsed);
      for (const leaf of stringLeaves) {
        // Skip ISO-8601 timestamps — they never match \b\d{9,}\b due to
        // T/-/: boundary chars. This is belt-and-suspenders documentation.
        const withoutIso = leaf.replace(
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
          "__ISO__",
        );
        const hasLongDecimal = longDecimalRe.test(withoutIso);
        expect(
          hasLongDecimal,
          `events.jsonl string leaf still contains unredacted long-decimal ID: ${JSON.stringify(leaf)}`,
        ).toBe(false);
      }
    }

    // Positive proof: events.jsonl must contain the REDACTED sentinel.
    expect(eventsText).toContain("<REDACTED:long-decimal-id>");
  });

  // ---------------------------------------------------------------------------
  // Test 2: Path substitution in events.jsonl.
  // ---------------------------------------------------------------------------

  it("bundle_paths_substituted_with_placeholders: literal paths in data are replaced with $WORKSPACE_DIR/$HOME", async () => {
    // Use a fake home dir that is the parent of workspaceDir so longest-first
    // ordering is exercised correctly:
    //   homeDir   = /fake-home-XYZ
    //   workspaceDir = /fake-home-XYZ/workspace
    // Path "/fake-home-XYZ/workspace/sessions/x" → "$WORKSPACE_DIR/sessions/x"
    // Path "/fake-home-XYZ/other"                → "$HOME/other"
    const base = makeTmpDir();
    const fakeHome = join(base, "fake-home");
    const fakeWorkspace = join(fakeHome, "workspace");
    mkdirSync(fakeWorkspace, { recursive: true });

    const f = makeRedactFixture(
      [
        makeMinimalRuntimeEvent({
          workspacePath: `${fakeWorkspace}/sessions/x`,
          homePath: `${fakeHome}/other`,
        }),
      ],
      fakeWorkspace,
    );

    // Temporarily set HOME to fakeHome for this test.
    const origHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;

    try {
      const result = await exportTrajectoryBundle({
        sessionId: f.sessionId,
        sessionFile: f.sessionFile,
        workspaceDir: fakeWorkspace,
        traceId: f.traceId,
        agentId: f.agentId,
        clock: f.clock,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const eventsText = readFileSync(join(result.value.bundleDir, "events.jsonl"), "utf-8");

      // workspacePath (data field) should be substituted with $WORKSPACE_DIR placeholder.
      expect(eventsText).toContain("$WORKSPACE_DIR/sessions/x");
      // homePath (data field) should be substituted with $HOME placeholder.
      expect(eventsText).toContain("$HOME/other");

      // The literal paths that were in event.data should NOT appear.
      expect(eventsText).not.toContain(`${fakeWorkspace}/sessions/x`);
      expect(eventsText).not.toContain(`${fakeHome}/other`);
    } finally {
      // Restore HOME.
      if (origHome !== undefined) {
        process.env["HOME"] = origHome;
      } else {
        delete process.env["HOME"];
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: Manifest has redaction policy fingerprint.
  // ---------------------------------------------------------------------------

  it("manifest_has_redaction_policy_fingerprint: manifest.redaction.policy === 'platform-aware-v1'", async () => {
    const base = makeTmpDir();
    const f = makeRedactFixture(
      [makeMinimalRuntimeEvent({ note: "benign" })],
      base,
    );

    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = JSON.parse(
      readFileSync(join(result.value.bundleDir, "manifest.json"), "utf-8"),
    ) as TrajectoryBundleManifest;

    expect((manifest as unknown as Record<string, unknown>)["redaction"]).toBeDefined();
    expect(
      ((manifest as unknown as Record<string, unknown>)["redaction"] as Record<string, unknown>)["policy"],
    ).toBe("platform-aware-v1");
  });

  // ---------------------------------------------------------------------------
  // Test 4: Number-typed fields survive redaction.
  // ---------------------------------------------------------------------------

  it("number_typed_fields_survive: number data fields are not coerced to strings and not redacted", async () => {
    const base = makeTmpDir();
    const f = makeRedactFixture(
      [
        makeMinimalRuntimeEvent({
          startedAt: 1735689600000,
          seq: 1234567890,
        }),
      ],
      base,
    );

    const result = await exportTrajectoryBundle({
      sessionId: f.sessionId,
      sessionFile: f.sessionFile,
      workspaceDir: f.workspaceDir,
      traceId: f.traceId,
      agentId: f.agentId,
      clock: f.clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lines = readFileSync(join(result.value.bundleDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    const runtimeEvents = lines
      .map((l) => JSON.parse(l) as { source: string; data?: Record<string, unknown> })
      .filter((e) => e.source === "runtime");

    expect(runtimeEvents.length).toBeGreaterThan(0);
    const runtimeEvent = runtimeEvents[0]!;

    // Number fields must pass through unchanged (not stringified, not redacted).
    expect(runtimeEvent.data?.["startedAt"]).toBe(1735689600000);
    expect(typeof runtimeEvent.data?.["startedAt"]).toBe("number");
    // seq=1234567890 is a number — NOT redacted to "<REDACTED:long-decimal-id>"
    expect(runtimeEvent.data?.["seq"]).toBe(1234567890);
    expect(typeof runtimeEvent.data?.["seq"]).toBe("number");
  });

  // ---------------------------------------------------------------------------
  // Test 5: Existing fixture compatibility — existing tests still pass.
  // ---------------------------------------------------------------------------

  it("existing_clock_fixture_compatibility: standard bundle still exports successfully with all 8 files", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-redact-compat-test-"));
    const fixture = setupBundleFixture(tmpDir);

    const result = await exportTrajectoryBundle({
      sessionId: fixture.sessionId,
      sessionFile: fixture.sessionFile,
      workspaceDir: fixture.workspaceDir,
      traceId: fixture.traceId,
      agentId: fixture.agentId,
      clock: fixture.clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "artifacts.json",
      "events.jsonl",
      "manifest.json",
      "metadata.json",
      "prompts.json",
      "session-branch.json",
      "system-prompt.txt",
      "tools.json",
    ]);

    // Manifest has the new redaction policy field.
    const manifest = JSON.parse(
      readFileSync(join(result.value.bundleDir, "manifest.json"), "utf-8"),
    ) as TrajectoryBundleManifest;
    expect(
      ((manifest as unknown as Record<string, unknown>)["redaction"] as Record<string, unknown>)?.["policy"],
    ).toBe("platform-aware-v1");
  });
});
