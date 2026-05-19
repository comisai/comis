// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `createSessionTrajectoryHandleRegistry` — the session-scoped
 * recorder lifecycle owner (design §6.4 + §6.5 + §6.8).
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
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedEventBus } from "@comis/core";

import { createSessionTrajectoryHandleRegistry } from "./session-registry.js";

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

describe("createSessionTrajectoryHandleRegistry — handle lifecycle", () => {
  it("getOrCreate_returns_same_recorder_across_multiple_calls", () => {
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const init = {
      agentId: "a",
      sessionId: "sid-1",
      trajectoryDir: tmpDir,
    };
    const first = reg.getOrCreate("k1", init, bus);
    const second = reg.getOrCreate("k1", init, bus);
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
      provider: "anthropic",
    };
    const init2 = {
      agentId: "agent-2", // would change agentId if re-constructed
      sessionId: "sid-1",
      trajectoryDir: tmpDir,
      provider: "openai",
    };
    const { recorder: r1 } = reg.getOrCreate("k1", init1, bus);
    const { recorder: r2 } = reg.getOrCreate("k1", init2, bus);
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
    const { recorder } = reg.getOrCreate(
      "k1",
      { agentId: "a", sessionId: "sid-c", trajectoryDir: tmpDir },
      bus,
    );
    expect(recorder).not.toBeNull();

    // Drive one event through the bus → bridge → recorder.
    bus.emit("session:started", {
      agentId: "a",
      sessionKey: "sk",
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
      sessionKey: "sk",
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
      const { recorder } = reg.getOrCreate(
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
    const { recorder: fresh } = reg.getOrCreate(
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
    const r1 = reg.getOrCreate("k1", init, bus).recorder;
    const r2 = reg.getOrCreate("k1", init, bus).recorder;
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});

describe("createSessionTrajectoryHandleRegistry — monotonic seq + single session.started/ended (design §6.4 + §6.8)", () => {
  it("seq_is_monotonic_across_multiple_event_batches_on_same_recorder", async () => {
    // Simulate two consecutive execute() calls (turns) feeding events
    // into the SAME recorder instance — that's exactly what the
    // registry's getOrCreate guarantees.
    const reg = createSessionTrajectoryHandleRegistry();
    const bus = new TypedEventBus();
    const { recorder } = reg.getOrCreate(
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
    const { recorder: same } = reg.getOrCreate(
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
    const { recorder } = reg.getOrCreate(
      "k-life",
      { agentId: "a", sessionId: "sid-life", trajectoryDir: tmpDir },
      bus,
    );
    expect(recorder).not.toBeNull();

    // Turn 1 — emit session:started (one).
    bus.emit("session:started", {
      agentId: "a",
      sessionKey: "sk",
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
