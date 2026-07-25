// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `createSessionTrajectoryHandleRegistry` — the session-scoped
 * recorder lifecycle owner.
 *
 * Behavior verified:
 *   - getOrCreate returns the SAME recorder across N calls for one key
 *   - first-init wins (later calls do NOT re-construct)
 *   - close flushes + unsubscribes + drops the entry
 *   - closeAll iterates every open entry
 *   - integration: two consecutive event batches against one recorder
 *     produce monotonic seq (1..M+N) AND exactly one session.started /
 *     zero session.ended until explicit close
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedEventBus } from "@comis/core";

import {
  createSessionTrajectoryHandleRegistry,
  type SessionTrajectoryFilter,
  type SessionTrajectoryHandleRegistry,
} from "./session-registry.js";
import type { TrajectoryRecorderInit } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-trj-reg-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function getOrCreate(
  registry: SessionTrajectoryHandleRegistry,
  formattedKey: string,
  init: TrajectoryRecorderInit,
  bus: TypedEventBus,
  filter?: SessionTrajectoryFilter,
): { recorder: ReturnType<SessionTrajectoryHandleRegistry["getRecorder"]> } {
  const result = registry.getOrCreate(formattedKey, init, bus, filter);
  if (!result.ok) throw result.error;
  return result.value;
}

describe("createSessionTrajectoryHandleRegistry — handle lifecycle", () => {
  it("getOrCreate_returns_same_recorder_across_multiple_calls", () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const init = {
      agentId: "a",
      sessionId: "sid-1",
      trajectoryDir: tmpDir,
    };
    const first = getOrCreate(reg, "k1", init, bus);
    const second = getOrCreate(reg, "k1", init, bus);
    expect(first.recorder).not.toBeNull();
    expect(second.recorder).toBe(first.recorder);
  });

  it("first_init_wins_for_subsequent_getOrCreate_calls_on_same_key", () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const init1 = {
      agentId: "agent-1",
      sessionId: "sid-1",
      trajectoryDir: tmpDir,
      model: { provider: "anthropic" },
    };
    const init2 = {
      agentId: "agent-2", // would change agentId if re-constructed
      sessionId: "sid-1",
      trajectoryDir: tmpDir,
      model: { provider: "openai" },
    };
    const { recorder: r1 } = getOrCreate(reg, "k1", init1, bus);
    const { recorder: r2 } = getOrCreate(reg, "k1", init2, bus);
    expect(r1).toBe(r2);
    // Behavioral proof: emit one event, inspect the recorder's
    // envelope — must reflect init1's agentId.
    expect(r1).not.toBeNull();
    r1!.recordEvent("session.started", {});
    return r1!.flush().then(() => {
      const lines = readLines(r1!.filePath);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.agentId).toBe("agent-1");
      expect(lines[0]!.provider).toBe("anthropic");
    });
  });

  it("close_flushes_and_unsubscribes_then_subsequent_emits_do_not_land", async () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const { recorder } = getOrCreate(
      reg,
      "k1",
      { agentId: "a", sessionId: "sid-c", trajectoryDir: tmpDir },
      bus,
    );
    expect(recorder).not.toBeNull();

    // Drive one event through the bus → bridge → recorder. The payload
    // sessionKey matches the registry key (as production bridge emits do) —
    // the owner-scoping filter drops foreign-session payloads.
    bus.emit("session:started", {
      agentId: "a",
      sessionKey: "k1",
      channelType: "telegram",
      channelId: "c1",
      traceId: "t1",
      timestamp: Date.now(),
    } as never);
    await recorder!.flush();

    let lines = readLines(recorder!.filePath);
    expect(lines).toHaveLength(1);

    // Close — unsubscribes + flushAndClose. After this the recorder
    // is permanently dropped; the next emit must NOT land.
    await reg.close("k1");

    bus.emit("session:started", {
      agentId: "a",
      sessionKey: "k1",
      channelType: "telegram",
      channelId: "c1",
      traceId: "t1",
      timestamp: Date.now(),
    } as never);

    lines = readLines(recorder!.filePath);
    expect(lines).toHaveLength(1); // unchanged
  });

  it("close_on_unknown_key_is_silent_noop", async () => {
    const reg = createSessionTrajectoryHandleRegistry();
    await expect(reg.close("never-created")).resolves.toBeUndefined();
  });

  it("closeAll_drains_every_open_session", async () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const handles: string[] = [];
    for (let i = 0; i < 3; i++) {
      const key = `k${i}`;
      const dir = join(tmpDir, key);
      // mkdir inline via the trajectoryDir absorption — the recorder
      // creates the parent at write time.
      const { recorder } = getOrCreate(
        reg,
        key,
        { agentId: "a", sessionId: key, trajectoryDir: tmpDir },
        bus,
      );
      handles.push(recorder!.filePath);
      recorder!.recordEvent("session.started", {});
    }
    await reg.closeAll();

    // Every file exists and contains its one event. Re-entering
    // getOrCreate now MUST construct a fresh entry (closeAll dropped
    // the map state).
    for (const f of handles) {
      const lines = readLines(f);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    }
    const { recorder: fresh } = getOrCreate(
      reg,
      "k0",
      { agentId: "a", sessionId: "fresh", trajectoryDir: tmpDir },
      bus,
    );
    expect(fresh).not.toBeNull();
  });

  it("handles_env_disabled_recorder_null_return: registry remembers the null entry", () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const init = {
      agentId: "a",
      sessionId: "sid-disabled",
      trajectoryDir: tmpDir,
      enabled: false,
    };
    const r1 = getOrCreate(reg, "k1", init, bus).recorder;
    const r2 = getOrCreate(reg, "k1", init, bus).recorder;
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("does not cache a persisted-state failure as an intentionally disabled recorder", () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const sessionFile = join(tmpDir, "retry.jsonl");
    writeFileSync(sessionFile, "", { mode: 0o600 });
    const trajectoryFile = `${sessionFile}.trajectory.jsonl`;
    writeFileSync(trajectoryFile, "not-json\n", { mode: 0o600 });
    const init = {
      agentId: "a",
      sessionId: "sid-retry",
      sessionFile,
      confinedBaseDir: tmpDir,
    };

    const failed = reg.getOrCreate("k-retry", init, bus);
    expect(failed.ok).toBe(false);
    expect(reg.getRecorder("k-retry")).toBeUndefined();

    writeFileSync(trajectoryFile, "", { mode: 0o600 });
    const recovered = reg.getOrCreate("k-retry", init, bus);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw recovered.error;
    expect(recovered.value.recorder).not.toBeNull();
  });
});

describe("SessionTrajectoryHandleRegistry — session:started latch", () => {
  it("has_session_started_been_emitted_returns_false_before_first_mark", () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    // Entry must exist (latch lives on SessionEntry) before consultation.
    getOrCreate(reg, "k-latch", { agentId: "a", sessionId: "sid-latch", trajectoryDir: tmpDir }, bus);
    expect(reg.hasSessionStartedBeenEmitted("k-latch")).toBe(false);
  });

  it("mark_session_started_flips_the_latch_and_is_idempotent", () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    getOrCreate(reg, "k-latch", { agentId: "a", sessionId: "sid-latch", trajectoryDir: tmpDir }, bus);
    expect(reg.hasSessionStartedBeenEmitted("k-latch")).toBe(false);
    reg.markSessionStarted("k-latch");
    expect(reg.hasSessionStartedBeenEmitted("k-latch")).toBe(true);
    // Second call is a no-op — still `true`.
    reg.markSessionStarted("k-latch");
    expect(reg.hasSessionStartedBeenEmitted("k-latch")).toBe(true);
  });

  it("has_session_started_returns_false_for_unknown_key", () => {
    // Bridge calls hasSessionStartedBeenEmitted BEFORE getOrCreate has
    // possibly materialized the entry (e.g., a stray agent_start event
    // for a session we haven't seen yet). The latch must safely default
    // to false so the first emit goes through.
    const reg = createSessionTrajectoryHandleRegistry();
    expect(reg.hasSessionStartedBeenEmitted("never-created")).toBe(false);
  });

  it("close_resets_the_latch_so_a_fresh_getOrCreate_re_emits", async () => {
    // A close drops the in-memory entry. With no persisted active start,
    // re-creation begins false; the restart test below covers restoration.
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    getOrCreate(reg, "k-reset", { agentId: "a", sessionId: "sid-reset", trajectoryDir: tmpDir }, bus);
    reg.markSessionStarted("k-reset");
    expect(reg.hasSessionStartedBeenEmitted("k-reset")).toBe(true);
    await reg.close("k-reset");
    getOrCreate(reg, "k-reset", { agentId: "a", sessionId: "sid-reset", trajectoryDir: tmpDir }, bus);
    expect(reg.hasSessionStartedBeenEmitted("k-reset")).toBe(false);
  });

  it("close_and_reopen_resets_the_latch_when_the_operator_filter_omits_session_ended", async () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const init = {
      agentId: "a",
      sessionId: "sid-filtered-reset",
      trajectoryDir: tmpDir,
    };
    const filter: SessionTrajectoryFilter = (eventName) =>
      eventName === "session:started";
    const first = getOrCreate(
      reg,
      "k-filtered-reset",
      init,
      bus,
      filter,
    ).recorder;
    expect(first).not.toBeNull();

    bus.emit("session:started", {
      agentId: "a",
      sessionKey: "k-filtered-reset",
      traceId: "trace-filtered-reset",
      channelType: "telegram",
      channelId: "chat",
      timestamp: 1,
    });
    reg.markSessionStarted("k-filtered-reset");
    bus.emit("session:ended", {
      agentId: "a",
      sessionKey: "k-filtered-reset",
      traceId: "trace-filtered-reset",
      totalTurns: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      durationMs: 1,
      exitReason: "destroyed",
      timestamp: 2,
    });
    await reg.close("k-filtered-reset");

    const persistedTypes = readLines(first!.filePath).map((line) => line.type);
    expect(persistedTypes).toEqual(["session.started", "session.ended"]);

    getOrCreate(reg, "k-filtered-reset", init, bus, filter);
    expect(
      reg.hasSessionStartedBeenEmitted("k-filtered-reset"),
    ).toBe(false);
  });

  it("fresh daemon registry restores an active session-start latch from the real trajectory layout", async () => {
    const channelDir = join(
      tmpDir,
      "workspace",
      "sessions",
      "default",
      "telegram",
    );
    mkdirSync(channelDir, { recursive: true });
    const sessionFile = join(channelDir, "chat.jsonl");
    writeFileSync(sessionFile, "", { mode: 0o600 });
    writeFileSync(
      sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
      JSON.stringify({ sessionId: "sid-restart" }),
      { mode: 0o600 },
    );
    const init = {
      agentId: "a",
      sessionId: "sid-restart",
      sessionFile,
      confinedBaseDir: tmpDir,
    };
    const firstRegistry = createSessionTrajectoryHandleRegistry();
    const firstBus = new TypedEventBus();
    const first = getOrCreate(firstRegistry, "k-restart", init, firstBus).recorder;
    expect(first).not.toBeNull();
    firstBus.emit("session:started", {
      agentId: "a",
      sessionKey: "k-restart",
      traceId: "trace-before-restart",
      channelType: "telegram",
      channelId: "chat",
      timestamp: 1,
    });
    firstRegistry.markSessionStarted("k-restart");
    await first!.flush();
    await firstRegistry.closeAll();

    const restartedRegistry = createSessionTrajectoryHandleRegistry();
    const restartedBus = new TypedEventBus();
    const restarted = getOrCreate(
      restartedRegistry,
      "k-restart",
      init,
      restartedBus,
    ).recorder;

    expect(restarted).not.toBeNull();
    expect(restartedRegistry.hasSessionStartedBeenEmitted("k-restart")).toBe(
      true,
    );
    expect(existsSync(`${sessionFile}.trajectory-path.json`)).toBe(true);
  });

  it("mark_session_started_on_unknown_key_is_silent_noop", () => {
    // Defensive: bridge calling markSessionStarted before getOrCreate
    // (shouldn't happen in production, but the API must not throw).
    const reg = createSessionTrajectoryHandleRegistry();
    expect(() => reg.markSessionStarted("never-created")).not.toThrow();
    expect(reg.hasSessionStartedBeenEmitted("never-created")).toBe(false);
  });
});

describe("createSessionTrajectoryHandleRegistry — monotonic seq + single session.started/ended", () => {
  it("seq_is_monotonic_across_multiple_event_batches_on_same_recorder", async () => {
    // Simulate two consecutive execute() calls (turns) feeding events
    // into the SAME recorder instance — that's exactly what the
    // registry's getOrCreate guarantees.
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const { recorder } = getOrCreate(
      reg,
      "k-monot",
      { agentId: "a", sessionId: "sid-monot", trajectoryDir: tmpDir },
      bus,
    );
    expect(recorder).not.toBeNull();

    // Turn 1 — 3 events.
    for (let i = 0; i < 3; i++) {
      recorder!.recordEvent("tool.call", { i });
    }
    // Turn 2 (no re-construction in between) — 4 events.
    const { recorder: same } = getOrCreate(
      reg,
      "k-monot",
      { agentId: "a", sessionId: "sid-monot", trajectoryDir: tmpDir },
      bus,
    );
    expect(same).toBe(recorder);
    for (let i = 3; i < 7; i++) {
      same!.recordEvent("tool.call", { i });
    }
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ seq: number; data: { i: number } }>;
    // Monotonic 1..7 across the two batches — no reset between turns.
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("exactly_one_session_started_and_zero_session_ended_before_close", async () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const { recorder } = getOrCreate(
      reg,
      "k-life",
      { agentId: "a", sessionId: "sid-life", trajectoryDir: tmpDir },
      bus,
    );
    expect(recorder).not.toBeNull();

    // Turn 1 — emit session:started (one). Payload sessionKey matches the
    // registry key (production emits do) — the owner filter requires it.
    bus.emit("session:started", {
      agentId: "a",
      sessionKey: "k-life",
      channelType: "telegram",
      channelId: "c1",
      traceId: "t1",
      timestamp: Date.now(),
    } as never);
    await recorder!.flush();

    // Turn 2 — pi-mono used to re-fire session:started here per-turn;
    // with session-scoped recorder lifecycle, the producer in
    // pi-event-bridge is responsible for only emitting it once. Our
    // registry-level invariant is: the recorder + bridge stay live
    // across turns, so when the producer DOES start emitting only
    // once per session, the trajectory carries exactly one
    // session.started.
    //
    // For this unit test we only verify the registry doesn't reset
    // events: emit ONE session:started → one event lands; emit ZERO
    // session:ended → zero land.
    await recorder!.flush();

    let lines = readLines(recorder!.filePath);
    const starts = lines.filter((l) => l.type === "session.started");
    const ends = lines.filter((l) => l.type === "session.ended");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(0);

    // Explicit close → flushAndClose → no `session.ended` is auto-injected
    // (the bridge maps `session:ended` from the bus, not from close).
    await reg.close("k-life");
    lines = readLines(recorder!.filePath);
    const endsAfter = lines.filter((l) => l.type === "session.ended");
    expect(endsAfter).toHaveLength(0);
  });
});
