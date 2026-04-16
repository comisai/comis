import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRestartContinuationTracker,
  loadContinuations,
  type ContinuationRecord,
} from "./restart-continuation.js";

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
    const count = tracker.capture(filePath, 60_000);

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
    const count = tracker.capture(filePath, 0);

    expect(count).toBe(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("capture returns 0 and skips file when no records", () => {
    const tracker = createRestartContinuationTracker();
    const filePath = join(tmpDir, "empty.json");
    const count = tracker.capture(filePath, 60_000);

    expect(count).toBe(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("track upserts by session key (deduplicates)", () => {
    const tracker = createRestartContinuationTracker();

    // Same channelType + channelId + userId + peerId = same key
    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1" }));
    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1" }));

    const filePath = join(tmpDir, "dedup.json");
    const count = tracker.capture(filePath, 60_000);

    expect(count).toBe(1);
  });

  it("different peerId produces separate records", () => {
    const tracker = createRestartContinuationTracker();

    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1", peerId: "peer-a" }));
    tracker.track(makeRecord({ channelId: "chat-1", userId: "u1", peerId: "peer-b" }));

    const filePath = join(tmpDir, "peers.json");
    const count = tracker.capture(filePath, 60_000);

    expect(count).toBe(2);
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
