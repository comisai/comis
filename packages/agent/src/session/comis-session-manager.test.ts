// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, statSync, readFileSync, symlinkSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionKey } from "@comis/core";
// Test-only core import — production session-write-lock does not depend on
// proper-lockfile; the FileLockPort adapter is constructed by the test
// harness instead.
import { createFileLock } from "@comis/core";
import { createComisSessionManager } from "./comis-session-manager.js";
import {
  sessionKeyToInboundMessageLedgerPath,
  sessionKeyToPath,
} from "./session-key-mapper.js";
import {
  appendInboundMessageProvenance,
  planInboundMessageProvenance,
} from "./inbound-message-provenance.js";

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

  it("removes the transcript and inbound ledger before removing the empty channel directory", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();

    // Simulate a session file
    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "bot.jsonl"), "{}");
    writeFileSync(join(channelDir, "bot~ledger~inbound.jsonl"), "ledger\n");

    await mgr.destroySession(key);

    expect(existsSync(join(channelDir, "bot.jsonl"))).toBe(false);
    expect(existsSync(join(channelDir, "bot~ledger~inbound.jsonl"))).toBe(false);
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

  it("rejects when the inbound ledger cannot be removed instead of reporting a reset", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    const eventBus = { emit: vi.fn() } as any;
    const recordEvent = vi.fn();
    const trajectoryRegistry = {
      close: vi.fn().mockResolvedValue(undefined),
      getRecorder: vi.fn(() => ({ recordEvent })),
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
    const ledgerPath = sessionKeyToInboundMessageLedgerPath(key, baseDir);
    mkdirSync(ledgerPath, { recursive: true });

    await expect(mgr.destroySession(key)).rejects.toThrow();

    expect(existsSync(ledgerPath)).toBe(true);
    expect(eventBus.emit).not.toHaveBeenCalledWith("session:ended", expect.anything());
    expect(recordEvent).not.toHaveBeenCalledWith("trace.artifacts", expect.anything());
    expect(trajectoryRegistry.close).not.toHaveBeenCalled();
  });
});

describe("appendInboundMessageLedger", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  it("appends the exact supplied content to an owner-only ledger file", () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey();
    const first = "{\"message\":\"first\"}\n";
    const second = "{\"message\":\"second\"}\n";

    const firstResult = mgr.appendInboundMessageLedger(key, first);
    const secondResult = mgr.appendInboundMessageLedger(key, second);

    expect(firstResult).toEqual({ ok: true, value: undefined });
    expect(secondResult).toEqual({ ok: true, value: undefined });
    const ledgerPath = sessionKeyToInboundMessageLedgerPath(key, baseDir);
    expect(readFileSync(ledgerPath, "utf8")).toBe(first + second);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it("keeps a fresh first-turn inbound durable before the SDK creates its assistant-gated transcript", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
    const key = makeKey("telegram-chat");
    const planned = planInboundMessageProvenance({
      id: "11111111-1111-4111-8111-111111111111",
      channelId: "telegram-chat",
      channelType: "telegram",
      senderId: "user_a",
      text: "first turn before any assistant",
      timestamp: 1_789_000_000_001,
      attachments: [],
      metadata: {},
    }, 1_789_000_100_000);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const outcome = await mgr.withSession(key, async (sessionManager) => {
      const ledgerWrite = mgr.appendInboundMessageLedger(key, planned.value.ledgerContent);
      expect(ledgerWrite.ok).toBe(true);
      const sdkWrite = appendInboundMessageProvenance(sessionManager, planned.value);
      expect(sdkWrite.ok).toBe(true);
    });

    expect(outcome.ok).toBe(true);
    expect(existsSync(sessionKeyToPath(key, baseDir))).toBe(false);
    expect(readFileSync(
      sessionKeyToInboundMessageLedgerPath(key, baseDir),
      "utf8",
    )).toBe(planned.value.ledgerContent);
  });

  it("returns an error when a symlinked session directory escapes confinement", () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    const outsideDir = makeTmpDir();
    dirs.push(baseDir, lockDir, outsideDir);
    const tenantDir = join(baseDir, "default");
    mkdirSync(tenantDir, { recursive: true });
    symlinkSync(outsideDir, join(tenantDir, "cron@3atest-job"));
    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });

    const result = mgr.appendInboundMessageLedger(makeKey(), "must not escape\n");

    expect(result.ok).toBe(false);
    expect(existsSync(join(outsideDir, "bot~ledger~inbound.jsonl"))).toBe(false);
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

  it("destroy_session_emits_session_ended_then_closes_registry_after_unlinking_jsonl", async () => {
    // Artifact removal must succeed before the lifecycle claims `destroyed`.
    // The successful order is unlink → emit → registry.close, preserving the
    // trajectory's session:ended flush before its recorder closes.
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    const key = makeKey();
    setupChannelDir(baseDir);
    const jsonlPath = join(baseDir, "default", "cron@3atest-job", "bot.jsonl");

    const callOrder: string[] = [];
    const eventBus = {
      emit: vi.fn((eventName: string) => {
        if (eventName === "session:ended") {
          expect(existsSync(jsonlPath)).toBe(false);
          callOrder.push("emit:session:ended");
        }
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
    expect(existsSync(jsonlPath)).toBe(true);

    await mgr.destroySession(key);

    // The callback above proves unlink happened before both lifecycle calls.
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

// ---------------------------------------------------------------------------
// getSessionStats
// ---------------------------------------------------------------------------

describe("getSessionStats", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  function makeManager() {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);
    return createComisSessionManager({ sessionBaseDir: baseDir, lockDir, cwd: baseDir, fileLock });
  }

  it("counts pi-native toolCall blocks and toolResult messages like the SDK's own session stats", async () => {
    const mgr = makeManager();
    const key = makeKey();

    const outcome = await mgr.withSession(key, async (sm) => {
      sm.appendMessage({ role: "user", content: "run the tool", timestamp: 1_700_000_000_000 } as any);
      sm.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "toolCall", id: "call-1", name: "exec", arguments: { cmd: "ls" } },
        ],
        api: "messages", provider: "anthropic", model: "test-model",
        usage: {
          input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        },
        stopReason: "toolUse",
        timestamp: 1_700_000_001_000,
      } as any);
      sm.appendMessage({
        role: "toolResult", toolCallId: "call-1", toolName: "exec",
        content: [{ type: "text", text: "ok" }], isError: false,
        timestamp: 1_700_000_002_000,
      } as any);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "messages", provider: "anthropic", model: "test-model",
        usage: {
          input: 200, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 230,
          cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
        },
        stopReason: "stop",
        timestamp: 1_700_000_003_000,
      } as any);
      return "seeded";
    });
    expect(outcome.ok).toBe(true);

    const stats = mgr.getSessionStats(key);
    expect(stats).toBeDefined();
    // pi sessions carry role "toolResult" and content type "toolCall" — the
    // Anthropic wire names ("tool", "tool_use") never appear in SDK-written
    // JSONL, so counting only those names reports 0 forever.
    expect(stats!.toolCalls).toBe(1);
    expect(stats!.toolResults).toBe(1);
    expect(stats!.userMessages).toBe(1);
    expect(stats!.assistantMessages).toBe(2);
    expect(stats!.messageCount).toBe(3);
    expect(stats!.tokens).toEqual({ input: 300, output: 80, cacheRead: 10, cacheWrite: 5, total: 395 });
    expect(stats!.cost).toBeCloseTo(0.004, 10);
  });

  it("still counts legacy Anthropic-named entries preserved in older session files", async () => {
    const mgr = makeManager();
    const key = makeKey();

    const outcome = await mgr.withSession(key, async (sm) => {
      sm.appendMessage({ role: "user", content: "legacy", timestamp: 1_700_000_000_000 } as any);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "tool_use", id: "legacy-1", name: "exec", input: { cmd: "ls" } }],
        api: "messages", provider: "anthropic", model: "test-model",
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1_700_000_001_000,
      } as any);
      sm.appendMessage({
        role: "tool", toolCallId: "legacy-1",
        content: [{ type: "text", text: "ok" }],
        timestamp: 1_700_000_002_000,
      } as any);
      return "seeded";
    });
    expect(outcome.ok).toBe(true);

    const stats = mgr.getSessionStats(key);
    expect(stats).toBeDefined();
    expect(stats!.toolCalls).toBe(1);
    expect(stats!.toolResults).toBe(1);
  });
});
