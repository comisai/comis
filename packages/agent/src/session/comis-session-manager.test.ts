// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionKey } from "@comis/core";
// Test-only core import — production session-write-lock does not depend on
// proper-lockfile; the FileLockPort adapter is constructed by the test
// harness instead.
import { createFileLock } from "@comis/core";
import { createComisSessionManager } from "./comis-session-manager.js";

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

describe("destroySession — session:ended emit + trajectoryRegistry close (design §6.4)", () => {
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
    // Legacy callers (tests, cross-session-graph ephemeral path) construct
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

describe("comis-session-manager honors §1.4 mode invariants on substrate-routed writes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  it("with_session_creates_per_channel_dir_with_mode_0o700", async () => {
    // withSession routes the per-channel directory creation through
    // ensureContainedDir so design §1.4's `0o700` invariant holds for every
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
    // writeRegularFile so design §1.4's `0o600` invariant holds for the
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
