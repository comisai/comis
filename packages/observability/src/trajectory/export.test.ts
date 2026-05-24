// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for export.ts foundations (Phase 4 Plan 01)
 * and readSessionBranch SESSION-01/SESSION-02 (Phase 4 Plan 02).
 *
 * Tests cover:
 *   - Hard-limit constants with exact values (design §5 D5 lines 318–321)
 *   - buildTranscriptEvents: parentEntryId chaining, sourceSeq assignment,
 *     ts passthrough from SDK entry.timestamp
 *   - sortTrajectoryEvents: primary ts sort, source-order tiebreak,
 *     sourceSeq tiebreak, non-mutation
 *   - TrajectoryBundleManifest + TrajectoryBundleWarning type conformance
 *     (compile-time; TypeScript must accept the literal shapes)
 *   - SESSION-01: SDK-written session entries carry parentId (SDK contract)
 *   - SESSION-02: readSessionBranch reconstructs branch, cycle detection,
 *     missing-parent detection, warning capping, file-not-found handling
 *
 * @module
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("export.ts foundations (Plan 04-01)", () => {
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

  it("TrajectoryBundleManifest is structurally assignable to design §6.2 shape", () => {
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
// readSessionBranch (SESSION-01 + SESSION-02) — Phase 4 Plan 02
// ---------------------------------------------------------------------------

// Suppress type-only import used only for test type assertions
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ReadSessionBranchResultCheck = ReadSessionBranchResult;

describe("readSessionBranch (SESSION-01 + SESSION-02)", () => {
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
  // SESSION-01: SDK-written session has parentId on every non-header entry
  // -------------------------------------------------------------------------

  it("SESSION-01: SDK-written session entries all have parentId field (SDK contract)", () => {
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

    // SESSION-01 contract: every non-header entry has parentId (string or null).
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
  // SESSION-02 Test 2: readSessionBranch on SDK-written session
  // -------------------------------------------------------------------------

  it("SESSION-02: readSessionBranch reconstructs chronological branch from SDK session", () => {
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
  // SESSION-02 Test 3: cycle detection emits cyclic-session-branch warning
  // -------------------------------------------------------------------------

  it("SESSION-02: cyclic session emits cyclic-session-branch warning and returns reachable suffix", () => {
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
  // SESSION-02 Test 4: missing-parent detection
  // -------------------------------------------------------------------------

  it("SESSION-02: missing-parent session emits incomplete-session-branch warning and returns reachable suffix", () => {
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
  // SESSION-02 Test 5: warning cap at MAX_TRAJECTORY_WARNING_ROWS=20
  // -------------------------------------------------------------------------

  it("SESSION-02: warning count > 20 but rows.length capped at MAX_TRAJECTORY_WARNING_ROWS", () => {
    const dir = makeTmpDir();

    // 25 separate chains, each pointing to a missing parent.
    // Each entry is a standalone "leaf" with a broken parentId.
    // The SDK tracks leafId as the last entry written, so we write them in order.
    // Each chain: entry_i -> missing_parent_i (separate broken chain).
    const entries: object[] = [];
    for (let i = 0; i < 25; i++) {
      entries.push(makeModelChangeEntry(`e${i}`, `missing-${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`));
    }

    const filePath = writeSyntheticSession(dir, entries);

    const result = readSessionBranch(filePath);

    // At least one incomplete-session-branch warning.
    const incompleteWarning = result.warnings.find((w) => w.code === "incomplete-session-branch");
    expect(incompleteWarning).toBeDefined();

    // True count preserved (all 25 missing parents encountered OR up to MAX_TRAJECTORY_TOTAL_EVENTS).
    expect(incompleteWarning!.count).toBe(25);

    // Rows capped at 20.
    expect(incompleteWarning!.rows.length).toBe(MAX_TRAJECTORY_WARNING_ROWS);
  });

  // -------------------------------------------------------------------------
  // SESSION-02 Test 6: missing file returns invalid-session-json warning, no throw
  // -------------------------------------------------------------------------

  it("SESSION-02: missing file path returns invalid-session-json warning without throwing", () => {
    const result = readSessionBranch("/nonexistent/path/that/does/not/exist.jsonl");

    expect(result.header).toBeNull();
    expect(result.leafId).toBeNull();
    expect(result.branchEntries.length).toBe(0);
    expect(result.warnings.some((w) => w.code === "invalid-session-json")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SESSION-02 Test 7: leaf-to-root walk direction (5-entry chain)
  // -------------------------------------------------------------------------

  it("SESSION-02: readSessionBranch reconstructs 5-entry chain in chronological root-first order", () => {
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
