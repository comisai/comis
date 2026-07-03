// SPDX-License-Identifier: Apache-2.0
/**
 * The durable per-session wake-state substrate
 * (`persistWakeStateSync` / `recoverWakeStates` / `removeWakeStateFile`),
 * modeled VERBATIM on `background-task-persistence.ts` — atomic confined
 * write (0o700 dir / 0o600 file via `@comis/observability`), a boot-time
 * recover scan that skips corrupt/unparseable files, and the best-effort
 * swallowed-error contract (a persist failure must never throw to the
 * caller; a corrupt file is skipped on recover).
 *
 * This is the "survives daemon restart" substrate the recurring
 * wake-dispatch FSM persists its dispatch state through.
 *
 * @module
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistWakeStateSync,
  recoverWakeStates,
  removeWakeStateFile,
  type PersistedWakeState,
} from "./terminal-wake-persistence.js";

function makeState(overrides: Partial<PersistedWakeState> = {}): PersistedWakeState {
  return {
    sessionId: "sess-a",
    owner: { agentId: "agent-1", sessionKey: "" },
    dispatchState: "pending",
    hopCount: 0,
    ...overrides,
  };
}

describe("terminal-wake-persistence (durable per-session wake-state)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "comis-wake-persist-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a persisted wake-state through persist then recover", () => {
    const state = makeState({
      sessionId: "sess-a",
      owner: { agentId: "agent-1", sessionKey: "sub-7" },
      dispatchState: "woken",
      hopCount: 2,
      pendingFrame: "req-42",
    });
    persistWakeStateSync(dataDir, state);

    const recovered = recoverWakeStates(dataDir);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(state);
  });

  it("recovers every persisted session on a simulated daemon restart", () => {
    persistWakeStateSync(dataDir, makeState({ sessionId: "sess-a", hopCount: 1 }));
    persistWakeStateSync(dataDir, makeState({ sessionId: "sess-b", dispatchState: "woken", hopCount: 3 }));
    persistWakeStateSync(dataDir, makeState({ sessionId: "sess-c", pendingFrame: "req-9" }));

    // Simulated restart: a fresh recover scan re-reads everything from disk.
    const recovered = recoverWakeStates(dataDir);
    const bySession = new Map(recovered.map((s) => [s.sessionId, s]));
    expect(bySession.size).toBe(3);
    expect(bySession.get("sess-a")?.hopCount).toBe(1);
    expect(bySession.get("sess-b")?.dispatchState).toBe("woken");
    expect(bySession.get("sess-c")?.pendingFrame).toBe("req-9");
  });

  it("does not throw to the caller when the persist target is unwritable (best-effort)", () => {
    // A dataDir that is actually a FILE makes the confined dir-creation fail;
    // the swallowed-error contract means persist must still not throw.
    const fileAsDir = join(dataDir, "not-a-dir");
    writeFileSync(fileAsDir, "x");
    expect(() => persistWakeStateSync(fileAsDir, makeState())).not.toThrow();
  });

  it("skips a corrupt/unparseable file on recover instead of throwing", () => {
    persistWakeStateSync(dataDir, makeState({ sessionId: "good" }));
    // Drop a corrupt JSON file into the wake dir alongside the good one.
    const wakeDir = join(dataDir, "terminal-wake");
    mkdirSync(wakeDir, { recursive: true });
    writeFileSync(join(wakeDir, "corrupt.json"), "{ this is not json");
    writeFileSync(join(wakeDir, "missing-fields.json"), JSON.stringify({ hopCount: 1 }));

    const recovered = recoverWakeStates(dataDir);
    // Only the well-formed state survives; the corrupt + shape-invalid are skipped.
    expect(recovered.map((s) => s.sessionId)).toEqual(["good"]);
  });

  it("returns an empty array when the data dir does not exist yet", () => {
    expect(recoverWakeStates(join(dataDir, "never-created"))).toEqual([]);
  });

  it("writes under a confined terminal-wake subdir of the data dir (0o700 dir / 0o600 file)", () => {
    persistWakeStateSync(dataDir, makeState({ sessionId: "sess-x" }));

    const wakeDir = join(dataDir, "terminal-wake");
    const entries = readdirSync(wakeDir);
    expect(entries).toContain("sess-x.json");

    // Dir mode 0o700, file mode 0o600 — the @comis/observability fs-safe invariants.
    expect(statSync(wakeDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(wakeDir, "sess-x.json")).mode & 0o777).toBe(0o600);

    const onDisk = JSON.parse(readFileSync(join(wakeDir, "sess-x.json"), "utf-8")) as PersistedWakeState;
    expect(onDisk.sessionId).toBe("sess-x");
  });

  it("removeWakeStateFile deletes the per-session file and is silent on ENOENT", () => {
    persistWakeStateSync(dataDir, makeState({ sessionId: "sess-rm" }));
    removeWakeStateFile(dataDir, "sess-rm");
    expect(recoverWakeStates(dataDir).map((s) => s.sessionId)).not.toContain("sess-rm");
    // Removing a non-existent file must not throw.
    expect(() => removeWakeStateFile(dataDir, "never-there")).not.toThrow();
  });

  // Recovery is best-effort + runs in the FSM CONSTRUCTOR — the keystone wiring calls
  // createTerminalWakeDispatcher at boot. A degenerate dataDir (e.g. a relative "." in a
  // test/bootstrap config) makes safePath throw PathTraversalError; recoverWakeStates
  // must SWALLOW that (return []) so it never crashes daemon boot. Without the guard the
  // unguarded wakeDir(".") call throws PathTraversalError out of the constructor.
  it("returns an empty array (never throws) for a degenerate relative dataDir like '.'", () => {
    expect(() => recoverWakeStates(".")).not.toThrow();
    expect(recoverWakeStates(".")).toEqual([]);
  });

  it("persistWakeStateSync + removeWakeStateFile stay best-effort (no throw) for a degenerate '.' dataDir", () => {
    expect(() => persistWakeStateSync(".", makeState({ sessionId: "sess-rel" }))).not.toThrow();
    expect(() => removeWakeStateFile(".", "sess-rel")).not.toThrow();
  });
});
