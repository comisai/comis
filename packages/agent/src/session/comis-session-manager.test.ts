// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, statSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionKey } from "@comis/core";
// Test-only core import — production session-write-lock does not depend on
// proper-lockfile; the FileLockPort adapter is constructed by the test
// harness instead.
import { createFileLock } from "@comis/core";
import { createComisSessionManager } from "./comis-session-manager.js";

// Mock @comis/observability so session-index writes don't hit real fs.
vi.mock("@comis/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/observability")>();
  return {
    ...actual,
    appendSessionIndexEntry: vi.fn().mockReturnValue("queued"),
  };
});

import { appendSessionIndexEntry as mockAppendSessionIndexEntry } from "@comis/observability";

const fileLock = createFileLock();

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "comis-session-mgr-test-"));
}

function makeKey(channelId = "cron:test-job"): SessionKey {
  return { tenantId: "default", userId: "bot", channelId };
}

describe("destroySession", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  it("removes empty channel directory after deleting JSONL", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();

    // Simulate a session file
    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "bot.jsonl"), "{}");

    await mgr.destroySession(key);

    expect(existsSync(join(channelDir, "bot.jsonl"))).toBe(false);
    expect(existsSync(channelDir)).toBe(false);
  });

  it("preserves channel directory when other files remain", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();

    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "bot.jsonl"), "{}");
    writeFileSync(join(channelDir, "other-user.jsonl"), "{}");

    await mgr.destroySession(key);

    expect(existsSync(join(channelDir, "bot.jsonl"))).toBe(false);
    expect(existsSync(channelDir)).toBe(true);
    expect(existsSync(join(channelDir, "other-user.jsonl"))).toBe(true);
  });

  it("does not throw when session file does not exist", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();

    await expect(mgr.destroySession(key)).resolves.not.toThrow();
  });
});

describe("destroySession — session:ended emit + trajectoryRegistry close", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  function setupChannelDir(baseDir: string): void {
    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "bot.jsonl"), "{}");
  }

  it("destroy_session_emits_session_ended_via_eventBus_with_exitReason_destroyed", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const eventBus = { emit: vi.fn() } as any;
    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      eventBus,
    });
    const key = makeKey();
    setupChannelDir(baseDir);

    await mgr.destroySession(key);

    const endedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === "session:ended");
    expect(endedCalls).toHaveLength(1);
    const payload = endedCalls[0][1] as Record<string, unknown>;
    // Formatted session key — sessionKeyToPath maps via formatSessionKey().
    expect(typeof payload.sessionKey).toBe("string");
    expect(payload.exitReason).toBe("destroyed");
    // The session manager doesn't accumulate per-session totals — payload
    // zeros are the documented placeholder shape.
    expect(payload.totalTurns).toBe(0);
    expect(payload.totalInputTokens).toBe(0);
    expect(payload.totalOutputTokens).toBe(0);
    expect(payload.durationMs).toBe(0);
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.agentId).toBe("");
  });

  it("destroy_session_calls_trajectory_registry_close_once_with_formatted_key", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const trajectoryRegistry = {
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn(),
      getOrCreate: vi.fn(),
      hasSessionStartedBeenEmitted: vi.fn().mockReturnValue(false),
      markSessionStarted: vi.fn(),
    } as any;
    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      trajectoryRegistry,
    });
    const key = makeKey();
    setupChannelDir(baseDir);

    await mgr.destroySession(key);

    expect(trajectoryRegistry.close).toHaveBeenCalledTimes(1);
    const calledKey = (trajectoryRegistry.close as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof calledKey).toBe("string");
    expect(calledKey).toContain("cron"); // contains the channel-id stem
  });

  it("destroy_session_emits_session_ended_then_closes_registry_before_unlinking_jsonl", async () => {
    // Order matters: emit → registry.close (flushAndClose drains queue
    // including the just-emitted session:ended → bridge → recordEvent
    // chain) → THEN unlink the session JSONL. The unlink races nothing
    // because the registry's flush awaits the writer's tail.
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const callOrder: string[] = [];
    const eventBus = {
      emit: vi.fn((eventName: string) => {
        if (eventName === "session:ended") callOrder.push("emit:session:ended");
      }),
    } as any;
    const trajectoryRegistry = {
      close: vi.fn(async () => { callOrder.push("registry:close"); }),
      closeAll: vi.fn(),
      getOrCreate: vi.fn(),
      hasSessionStartedBeenEmitted: vi.fn().mockReturnValue(false),
      markSessionStarted: vi.fn(),
    } as any;
    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      eventBus,
      trajectoryRegistry,
    });
    const key = makeKey();
    setupChannelDir(baseDir);
    const jsonlPath = join(baseDir, "default", "cron@3atest-job", "bot.jsonl");
    expect(existsSync(jsonlPath)).toBe(true);

    await mgr.destroySession(key);

    // The unlink HAPPENED (file gone) AFTER both emit + registry.close.
    expect(existsSync(jsonlPath)).toBe(false);
    expect(callOrder[0]).toBe("emit:session:ended");
    expect(callOrder[1]).toBe("registry:close");
  });

  it("destroy_session_works_without_optional_deps_eventBus_and_trajectoryRegistry_omitted", async () => {
    // Some callers (tests, cross-session-graph ephemeral path) construct
    // ComisSessionManager without eventBus / trajectoryRegistry. The unlink
    // must still happen; the emit + registry-close steps are silent no-ops.
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
    });
    const key = makeKey();
    setupChannelDir(baseDir);
    const jsonlPath = join(baseDir, "default", "cron@3atest-job", "bot.jsonl");

    await expect(mgr.destroySession(key)).resolves.not.toThrow();
    expect(existsSync(jsonlPath)).toBe(false);
  });
});

describe("comis-session-manager mode invariants on substrate-routed writes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  it("with_session_creates_per_channel_dir_with_mode_0o700", async () => {
    // withSession routes the per-channel directory creation through
    // ensureContainedDir so the `0o700` mode invariant holds for every
    // artifact dir under ~/.comis/agents/.
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();

    // Drive a no-op withSession to trigger directory creation
    await mgr.withSession(key, async () => "ok");

    const channelDir = join(baseDir, "default", "cron@3atest-job");
    // The substrate's defensive chmod runs on EEXIST as well as fresh
    // create, so the assertion holds regardless of whether the dir
    // pre-existed (e.g., from a sibling-test interleave).
    expect(statSync(channelDir).mode & 0o777).toBe(0o700);
  });

  it("write_session_metadata_writes_companion_file_with_mode_0o600", async () => {
    // writeSessionMetadata routes the sentinel JSON write through
    // writeRegularFile so the `0o600` mode invariant holds for the
    // `_session-metadata.json` companion file.
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();

    // Pre-create the channel dir so the metadata write site has a parent
    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true, mode: 0o700 });

    mgr.writeSessionMetadata(key, {
      traceId: "trace-mode-test",
      runId: "run-mode-test",
    });

    const metadataPath = join(channelDir, "bot_session-metadata.json");
    expect(existsSync(metadataPath)).toBe(true);
    expect(statSync(metadataPath).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// sessionEnd flight-recorder rollup fields round-trip
// ---------------------------------------------------------------------------

describe("write_session_metadata round-trips the health-rollup fields on sessionEnd", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  function setupMgr(): { mgr: ReturnType<typeof createComisSessionManager>; key: SessionKey; metadataPath: string } {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();
    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true, mode: 0o700 });
    return { mgr, key, metadataPath: join(channelDir, "bot_session-metadata.json") };
  }

  it("persists degraded, costUsd, toolStats, breakerTripCount, and topErrorKinds verbatim on a write→read cycle", () => {
    const { mgr, key, metadataPath } = setupMgr();

    mgr.writeSessionMetadata(key, {
      sessionEnd: {
        type: "session_end",
        timestamp: "2026-06-07T00:00:00.000Z",
        endReason: "completed_with_tool_errors",
        durationMs: 1000,
        totalTokens: 500,
        degraded: true,
        costUsd: 1.45,
        toolStats: { web_fetch: { ok: 2, failed: 8 } },
        breakerTripCount: 1,
        topErrorKinds: { dependency: 8 },
      },
    });

    expect(existsSync(metadataPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
      sessionEnd: NonNullable<import("./comis-session-manager.js").SessionMetadata["sessionEnd"]>;
    };
    expect(persisted.sessionEnd.degraded).toBe(true);
    expect(persisted.sessionEnd.costUsd).toBe(1.45);
    expect(persisted.sessionEnd.toolStats).toEqual({ web_fetch: { ok: 2, failed: 8 } });
    expect(persisted.sessionEnd.breakerTripCount).toBe(1);
    expect(persisted.sessionEnd.topErrorKinds).toEqual({ dependency: 8 });
  });

  it("still round-trips the four required fields when the five optional rollup fields are omitted", () => {
    const { mgr, key, metadataPath } = setupMgr();

    // Required-fields-only sessionEnd: no degraded/costUsd/toolStats/breakerTripCount/topErrorKinds.
    mgr.writeSessionMetadata(key, {
      sessionEnd: {
        type: "session_end",
        timestamp: "2026-06-07T00:00:00.000Z",
        endReason: "success",
        durationMs: 250,
        totalTokens: 42,
      },
    });

    expect(existsSync(metadataPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
      sessionEnd: NonNullable<import("./comis-session-manager.js").SessionMetadata["sessionEnd"]>;
    };
    expect(persisted.sessionEnd.type).toBe("session_end");
    expect(persisted.sessionEnd.endReason).toBe("success");
    expect(persisted.sessionEnd.durationMs).toBe(250);
    expect(persisted.sessionEnd.totalTokens).toBe(42);
    // Omitted optional fields stay absent (readers ignore missing optional fields).
    expect(persisted.sessionEnd.degraded).toBeUndefined();
    expect(persisted.sessionEnd.costUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// trace.artifacts emit BEFORE session:ended
// ---------------------------------------------------------------------------

describe("trace.artifacts direct emit before session:ended in destroySession", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  function setupChannelDir(baseDir: string): void {
    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "bot.jsonl"), "{}");
  }

  it("emits trace.artifacts via recorder BEFORE session:ended bus emit", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    setupChannelDir(baseDir);

    const order: string[] = [];
    const mockRecorder = {
      recordEvent: (type: string) => { order.push(`recorder:${type}`); return "queued" as const; },
      flush: vi.fn(),
      flushAndClose: vi.fn().mockResolvedValue(undefined),
      filePath: "/tmp/test.trajectory.jsonl",
    };

    const trajectoryRegistry = {
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn(),
      getOrCreate: vi.fn(),
      hasSessionStartedBeenEmitted: vi.fn().mockReturnValue(false),
      markSessionStarted: vi.fn(),
      getRecorder: vi.fn().mockReturnValue(mockRecorder),
    } as any;

    const eventBus = {
      emit: vi.fn((eventName: string) => { order.push(`bus:${eventName}`); }),
    } as any;

    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      eventBus,
      trajectoryRegistry,
    });

    await mgr.destroySession(makeKey());

    const artifactsIdx = order.findIndex((e) => e === "recorder:trace.artifacts");
    const sessionEndedIdx = order.findIndex((e) => e === "bus:session:ended");

    expect(artifactsIdx).toBeGreaterThanOrEqual(0);
    expect(sessionEndedIdx).toBeGreaterThanOrEqual(0);
    // trace.artifacts must appear BEFORE session:ended bus emit
    expect(artifactsIdx).toBeLessThan(sessionEndedIdx);
  });

  it("emits trace.artifacts exactly once per destroySession call", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    setupChannelDir(baseDir);

    const recordedTypes: string[] = [];
    const mockRecorder = {
      recordEvent: (type: string) => { recordedTypes.push(type); return "queued" as const; },
      flush: vi.fn(),
      flushAndClose: vi.fn().mockResolvedValue(undefined),
      filePath: "/tmp/test.trajectory.jsonl",
    };

    const trajectoryRegistry = {
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn(),
      getOrCreate: vi.fn(),
      hasSessionStartedBeenEmitted: vi.fn().mockReturnValue(false),
      markSessionStarted: vi.fn(),
      getRecorder: vi.fn().mockReturnValue(mockRecorder),
    } as any;

    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      trajectoryRegistry,
    });

    await mgr.destroySession(makeKey());

    const artifactsEmits = recordedTypes.filter((t) => t === "trace.artifacts");
    expect(artifactsEmits).toHaveLength(1);
  });

  it("emitted trace.artifacts payload has required keys from sessionStateProvider", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    setupChannelDir(baseDir);

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const mockRecorder = {
      recordEvent: (type: string, data?: Record<string, unknown>) => {
        if (type === "trace.artifacts" && data !== undefined) capturedPayloads.push(data);
        return "queued" as const;
      },
      flush: vi.fn(),
      flushAndClose: vi.fn().mockResolvedValue(undefined),
      filePath: "/tmp/test.trajectory.jsonl",
    };

    const trajectoryRegistry = {
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn(),
      getOrCreate: vi.fn(),
      hasSessionStartedBeenEmitted: vi.fn().mockReturnValue(false),
      markSessionStarted: vi.fn(),
      getRecorder: vi.fn().mockReturnValue(mockRecorder),
    } as any;

    const sessionStateProvider = vi.fn().mockReturnValue({
      finalStatus: "stop",
      aborted: false,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 10, cacheWriteTokens: 0 },
      cumulativeCostUsd: 0.005,
      turnCount: 3,
    });

    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      trajectoryRegistry,
      sessionStateProvider,
    });

    await mgr.destroySession(makeKey());

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0];
    expect(payload.finalStatus).toBe("stop");
    expect(payload.aborted).toBe(false);
    expect(payload.usage).toBeDefined();
    expect(payload.cumulativeCostUsd).toBeDefined();
    expect(payload.turnCount).toBe(3);
  });

  it("uses fallback 'destroyed' payload when no sessionStateProvider is registered", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    setupChannelDir(baseDir);

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const mockRecorder = {
      recordEvent: (type: string, data?: Record<string, unknown>) => {
        if (type === "trace.artifacts" && data !== undefined) capturedPayloads.push(data);
        return "queued" as const;
      },
      flush: vi.fn(),
      flushAndClose: vi.fn().mockResolvedValue(undefined),
      filePath: "/tmp/test.trajectory.jsonl",
    };

    const trajectoryRegistry = {
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn(),
      getOrCreate: vi.fn(),
      hasSessionStartedBeenEmitted: vi.fn().mockReturnValue(false),
      markSessionStarted: vi.fn(),
      getRecorder: vi.fn().mockReturnValue(mockRecorder),
    } as any;

    // No sessionStateProvider
    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      trajectoryRegistry,
    });

    await mgr.destroySession(makeKey());

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0].finalStatus).toBe("destroyed");
    expect(capturedPayloads[0].aborted).toBe(false);
    expect(capturedPayloads[0].turnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// session-index session_ended emit site
// ---------------------------------------------------------------------------

describe("session-index session_ended emit", () => {
  const indexDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const d of indexDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    indexDirs.length = 0;
  });

  it("appendSessionIndexEntry called once with session_ended payload on destroySession", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "comis-sidx-mgr-test-"));
    const lockDir = mkdtempSync(join(tmpdir(), "comis-sidx-lock-test-"));
    indexDirs.push(baseDir, lockDir);

    const fakeEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn(), listenerCount: vi.fn().mockReturnValue(0) } as any;
    const key: SessionKey = { tenantId: "default", userId: "bot", channelId: "cron:test-job" };

    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      fileLock,
      eventBus: fakeEventBus,
    });

    await mgr.destroySession(key);

    const appendMock = vi.mocked(mockAppendSessionIndexEntry);
    const sessionEndedCalls = appendMock.mock.calls.filter(
      (c) => c[1].event === "session_ended",
    );
    expect(sessionEndedCalls).toHaveLength(1);

    const payload = sessionEndedCalls[0][1] as { event: string; exitReason: string; traceSchema: string; schemaVersion: number; sessionId: string };
    expect(payload.event).toBe("session_ended");
    expect(payload.traceSchema).toBe("comis-session-index");
    expect(payload.schemaVersion).toBe(1);
    expect(payload.exitReason).toBe("destroyed");
    expect(typeof payload.sessionId).toBe("string");
  });
});
