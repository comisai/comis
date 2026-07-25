// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRestartContinuationTracker,
  loadContinuations,
  buildMcpStatusLine,
  resolveContinuationLanguage,
  type ContinuationRecord,
} from "./restart-continuation.js";
import type { McpConnection } from "@comis/skills";
import { runWithContext } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ContinuationRecord>): ContinuationRecord {
  return {
    agentId: "agent-1",
    channelType: "telegram",
    channelId: "chat-123",
    userId: "user-1",
    tenantId: "default",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeMockLogger()),
    audit: vi.fn(),
    level: "debug",
  } as any;
}

// ---------------------------------------------------------------------------
// createRestartContinuationTracker
// ---------------------------------------------------------------------------

describe("createRestartContinuationTracker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "restart-cont-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("capture writes recent records to JSON file", () => {
    const tracker = createRestartContinuationTracker();
    tracker.track(makeRecord({ channelId: "chat-1" }));
    tracker.track(makeRecord({ channelId: "chat-2" }));

    const filePath = join(tmpDir, "continuations.json");
    const count = tracker.capture(filePath, 60_000, tmpDir);

    expect(count).toBe(2);
    expect(existsSync(filePath)).toBe(true);

    const written: ContinuationRecord[] = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(written).toHaveLength(2);
    expect(written.map((r) => r.channelId).sort()).toEqual(["chat-1", "chat-2"]);
  });

  it("capture filters records outside the recent window", () => {
    const tracker = createRestartContinuationTracker();

    // Track a record then manually set an old timestamp via re-tracking
    tracker.track(makeRecord({ channelId: "old-chat" }));

    // Track a fresh record
    tracker.track(makeRecord({ channelId: "new-chat" }));

    // Capture with 0ms window — nothing is recent
    const filePath = join(tmpDir, "continuations.json");
    const count = tracker.capture(filePath, 0, tmpDir);

    expect(count).toBe(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("capture returns 0 and skips file when no records", () => {
    const tracker = createRestartContinuationTracker();
    const filePath = join(tmpDir, "empty.json");
    const count = tracker.capture(filePath, 60_000, tmpDir);

    expect(count).toBe(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("track upserts by session key (deduplicates)", () => {
    const tracker = createRestartContinuationTracker();

    // Same channelType + channelId + userId + peerId = same key
    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1" }));
    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1" }));

    const filePath = join(tmpDir, "dedup.json");
    const count = tracker.capture(filePath, 60_000, tmpDir);

    expect(count).toBe(1);
  });

  it("different peerId produces separate records", () => {
    const tracker = createRestartContinuationTracker();

    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1", peerId: "peer-a" }));
    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1", peerId: "peer-b" }));

    const filePath = join(tmpDir, "peers.json");
    const count = tracker.capture(filePath, 60_000, tmpDir);

    expect(count).toBe(2);
  });

  it("completed turns are excluded from restart capture", () => {
    const tracker = createRestartContinuationTracker();
    const record = makeRecord({ channelId: "settled-chat" });

    tracker.track(record);
    tracker.complete(record);

    const filePath = join(tmpDir, "settled.json");
    expect(tracker.isTracked(record)).toBe(false);
    expect(tracker.capture(filePath, 60_000, tmpDir)).toBe(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("earlier completion keeps an overlapping turn active", () => {
    const tracker = createRestartContinuationTracker();
    const first = makeRecord({ channelId: "overlap-chat", resolvedLanguage: "en" });
    const second = makeRecord({ channelId: "overlap-chat", resolvedLanguage: "fr" });

    tracker.track(first);
    tracker.track(second);
    tracker.complete(first);

    const filePath = join(tmpDir, "overlap.json");
    expect(tracker.isTracked(second)).toBe(true);
    expect(tracker.capture(filePath, 60_000, tmpDir)).toBe(1);
    const written: ContinuationRecord[] = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(written[0]?.resolvedLanguage).toBe("fr");

    tracker.complete(second);
    expect(tracker.isTracked(second)).toBe(false);
  });

  it("preserves chatType across track -> capture -> loadContinuations round trip", () => {
    // Regression: synthetic restart messages were mis-framing group sessions
    // as DMs because chatType was not captured. The full round-trip must
    // preserve telegramChatType so resolveChatType returns "group" on the
    // first post-restart turn.
    const tracker = createRestartContinuationTracker();
    tracker.track(makeRecord({ channelId: "group-chat", chatType: "supergroup" }));
    tracker.track(makeRecord({ channelId: "dm-chat", userId: "u-dm", chatType: "private" }));
    tracker.track(makeRecord({ channelId: "no-meta", userId: "u-nm" })); // chatType omitted

    const filePath = join(tmpDir, "round-trip.json");
    const wrote = tracker.capture(filePath, 60_000, tmpDir);
    expect(wrote).toBe(3);

    const logger = makeMockLogger();
    const loaded = loadContinuations(filePath, 300_000, logger);
    expect(loaded).toHaveLength(3);

    const byChannel = new Map(loaded.map((r) => [r.channelId, r]));
    expect(byChannel.get("group-chat")?.chatType).toBe("supergroup");
    expect(byChannel.get("dm-chat")?.chatType).toBe("private");
    expect(byChannel.get("no-meta")?.chatType).toBeUndefined();
  });

  it("preserves the resolved response language across a restart round trip", () => {
    const tracker = createRestartContinuationTracker();
    tracker.track(makeRecord({ resolvedLanguage: "und-Hebr" }));

    const filePath = join(tmpDir, "language-round-trip.json");
    expect(tracker.capture(filePath, 60_000, tmpDir)).toBe(1);

    const loaded = loadContinuations(filePath, 300_000, makeMockLogger());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.resolvedLanguage).toBe("und-Hebr");
  });
});

describe("resolveContinuationLanguage", () => {
  it("derives the response script from the original inbound text", () => {
    expect(resolveContinuationLanguage({
      text: "סכם את ציוני הבטיחות לפי קבוצות הרכב",
      metadata: {},
    })).toBe("und-Hebr");
  });

  it("retains the trusted locale for an English synthetic restart message", () => {
    const resolved = runWithContext({
      traceId: "trace-restart-language",
      startedAt: Date.now(),
      resolvedLanguage: "und-Hebr",
    }, () => resolveContinuationLanguage({
      text: "[system: daemon restarted]",
      metadata: { isRestartContinuation: true },
    }));

    expect(resolved).toBe("und-Hebr");
  });
});

// ---------------------------------------------------------------------------
// loadContinuations
// ---------------------------------------------------------------------------

describe("loadContinuations", () => {
  let tmpDir: string;
  let logger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "restart-load-"));
    logger = makeMockLogger();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when file does not exist", () => {
    const result = loadContinuations(join(tmpDir, "missing.json"), 300_000, logger);
    expect(result).toEqual([]);
  });

  it("loads and returns non-stale records", () => {
    const records = [
      makeRecord({ channelId: "c1", timestamp: Date.now() }),
      makeRecord({ channelId: "c2", timestamp: Date.now() }),
    ];
    const filePath = join(tmpDir, "cont.json");
    writeFileSync(filePath, JSON.stringify(records), "utf-8");

    const result = loadContinuations(filePath, 300_000, logger);

    expect(result).toHaveLength(2);
    // File should be deleted after load
    expect(existsSync(filePath)).toBe(false);
  });

  it("filters stale records (>staleTtlMs old)", () => {
    const records = [
      makeRecord({ channelId: "fresh", timestamp: Date.now() }),
      makeRecord({ channelId: "stale", timestamp: Date.now() - 600_000 }), // 10 min old
    ];
    const filePath = join(tmpDir, "stale.json");
    writeFileSync(filePath, JSON.stringify(records), "utf-8");

    const result = loadContinuations(filePath, 300_000, logger); // 5 min TTL

    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe("fresh");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ discarded: 1, total: 2 }),
      expect.any(String),
    );
  });

  it("handles corrupted file gracefully", () => {
    const filePath = join(tmpDir, "corrupt.json");
    writeFileSync(filePath, "not valid json{{{", "utf-8");

    const result = loadContinuations(filePath, 300_000, logger);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
    // File should be cleaned up
    expect(existsSync(filePath)).toBe(false);
  });

  it("deletes file after successful load", () => {
    const records = [makeRecord()];
    const filePath = join(tmpDir, "cleanup.json");
    writeFileSync(filePath, JSON.stringify(records), "utf-8");

    loadContinuations(filePath, 300_000, logger);

    expect(existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildMcpStatusLine
// ---------------------------------------------------------------------------

function mockConn(overrides: { name: string; status: McpConnection["status"]; error?: string }): McpConnection {
  return {
    name: overrides.name,
    status: overrides.status,
    error: overrides.error,
    client: {} as McpConnection["client"],
    tools: [],
    lastHealthCheck: 0,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 0,
  } as McpConnection;
}

describe("buildMcpStatusLine", () => {
  it("returns undefined for an empty connection list", () => {
    expect(buildMcpStatusLine([])).toBeUndefined();
  });

  it("returns undefined when all connections are connected", () => {
    const conns = [
      mockConn({ name: "a", status: "connected" }),
      mockConn({ name: "b", status: "connected" }),
    ];
    expect(buildMcpStatusLine(conns)).toBeUndefined();
  });

  it("formats a single errored connection with a short error", () => {
    const conns = [
      mockConn({ name: "gemini-imagen", status: "error", error: "Connection closed" }),
    ];
    const line = buildMcpStatusLine(conns);
    expect(line).toBeDefined();
    expect(line!.startsWith("[MCP Status]")).toBe(true);
    expect(line).toContain("gemini-imagen");
    expect(line).toContain("Connection closed");
    expect(line).not.toContain("+");
  });

  it("truncates error messages longer than 120 chars with an ellipsis", () => {
    const longError = "x".repeat(300);
    const conns = [mockConn({ name: "noisy", status: "error", error: longError })];
    const line = buildMcpStatusLine(conns)!;
    expect(line).toContain("noisy (");
    const truncatedSegment = "x".repeat(120) + "…";
    expect(line).toContain(truncatedSegment);
    expect(line).not.toContain("x".repeat(121));
  });

  it("falls back to 'unknown error' when error field is missing or empty", () => {
    const missing = mockConn({ name: "mystery", status: "error" });
    const empty = mockConn({ name: "blank", status: "error", error: "   " });
    const lineMissing = buildMcpStatusLine([missing])!;
    const lineEmpty = buildMcpStatusLine([empty])!;
    expect(lineMissing).toContain("mystery (unknown error)");
    expect(lineMissing).not.toContain("undefined");
    expect(lineEmpty).toContain("blank (unknown error)");
  });

  it("lists first 5 names verbatim and summarizes the rest as '+N more' when >5 failures", () => {
    const conns = Array.from({ length: 7 }, (_, i) =>
      mockConn({ name: `srv-${i + 1}`, status: "error", error: "boom" }),
    );
    const line = buildMcpStatusLine(conns)!;
    expect(line).toContain("7 server(s) failed to connect:");
    for (let i = 1; i <= 5; i += 1) {
      expect(line).toContain(`srv-${i} (boom)`);
    }
    expect(line).toContain("+2 more");
    expect(line).not.toContain("srv-6");
    expect(line).not.toContain("srv-7");
  });

  it("only includes status='error' connections; excludes reconnecting/disconnected/connected", () => {
    const conns = [
      mockConn({ name: "healthy-srv", status: "connected" }),
      mockConn({ name: "retry-srv", status: "reconnecting", error: "hiccup" }),
      mockConn({ name: "idle-srv", status: "disconnected", error: "closed" }),
      mockConn({ name: "failed-srv", status: "error", error: "fatal" }),
    ];
    const line = buildMcpStatusLine(conns)!;
    expect(line).toContain("1 server(s) failed to connect:");
    expect(line).toContain("failed-srv (fatal)");
    expect(line).not.toContain("retry-srv");
    expect(line).not.toContain("idle-srv");
    expect(line).not.toContain("healthy-srv");
    expect(line).not.toContain("hiccup");
    expect(line).not.toContain("closed");
  });

  it("places the [MCP Status] prefix exactly once and at position 0", () => {
    const conns = [
      mockConn({ name: "a", status: "error", error: "boom" }),
      mockConn({ name: "b", status: "error", error: "bang" }),
    ];
    const line = buildMcpStatusLine(conns)!;
    expect(line.indexOf("[MCP Status]")).toBe(0);
    expect(line.match(/\[MCP Status\]/g)!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mode-invariant tests (tmpdir-scoped, real fs).
//
// The migrated writer must produce artifacts at mode `0o600`.
// Restart-continuation writes a single JSON file via the fs-safe
// substrate; the parent dir is the operator's `dataDir` (already
// `0o700` from the daemon's bootstrap). This test asserts the
// file-mode invariant on the artifact this writer creates.
// ---------------------------------------------------------------------------

describe("restart-continuation honors §1.4 mode invariants", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "comis-restart-cont-mode-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes_continuation_file_with_mode_0o600", () => {
    const tracker = createRestartContinuationTracker();
    tracker.track(makeRecord({ channelId: "mode-check" }));
    const filePath = join(baseDir, "restart-continuations.json");
    const count = tracker.capture(filePath, 60_000, baseDir);
    expect(count).toBe(1);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
