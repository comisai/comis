// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { reapNeverTaskedDrives, type ReapUntaskedRegistry } from "./terminal-reap-untasked.js";
import type { SessionOwner } from "./terminal-session-owner.js";
import type { SessionListing, SessionHandle } from "./terminal-session-types.js";

const OWNER: SessionOwner = { agentId: "hook:devtask:x", sessionKey: "default:hook:devtask:x:webhook" };

function listing(sessionId: string, alive = true): SessionListing {
  return { sessionId, allowId: "claude", command: "claude", alive, lastActivity: 0 };
}

function handle(sessionId: string, everSentText: boolean): SessionHandle {
  return {
    sessionId, allowId: "claude", command: "claude", status: "running",
    cols: 80, rows: 24, lastActivity: 0, startedAt: 0,
    owner: OWNER, durable: true, everSentText,
  } as SessionHandle;
}

/** A structural mock registry over a fixed handle map. */
function makeRegistry(handles: Map<string, SessionHandle | undefined>, opts?: { killThrowsFor?: string }): {
  registry: ReapUntaskedRegistry;
  kills: string[];
} {
  const kills: string[] = [];
  const registry: ReapUntaskedRegistry = {
    list: () => [...handles.keys()].map((id) => listing(id, handles.get(id) ? handles.get(id)!.status !== "exited" : true)),
    get: (sessionId, owner) => (owner.agentId === OWNER.agentId ? handles.get(sessionId) : undefined),
    kill: async (sessionId) => {
      if (opts?.killThrowsFor === sessionId) throw new Error("kill failed");
      kills.push(sessionId);
    },
  };
  return { registry, kills };
}

describe("reapNeverTaskedDrives — deterministic unattended honest-fail backstop", () => {
  it("reaps a LIVE never-tasked drive (everSentText=false) and returns its id", async () => {
    const { registry, kills } = makeRegistry(new Map([["s1", handle("s1", false)]]));
    const { reaped } = await reapNeverTaskedDrives(registry, OWNER);
    expect(reaped).toEqual(["s1"]);
    expect(kills).toEqual(["s1"]);
  });

  it("does NOT reap a TASKED drive (everSentText=true) — it did real work", async () => {
    const { registry, kills } = makeRegistry(new Map([["s1", handle("s1", true)]]));
    const { reaped } = await reapNeverTaskedDrives(registry, OWNER);
    expect(reaped).toEqual([]);
    expect(kills).toEqual([]);
  });

  it("does NOT reap a dead (alive:false) drive", async () => {
    const dead = handle("s1", false);
    (dead as { status: string }).status = "exited";
    const { registry, kills } = makeRegistry(new Map([["s1", dead]]));
    const { reaped } = await reapNeverTaskedDrives(registry, OWNER);
    expect(reaped).toEqual([]);
    expect(kills).toEqual([]);
  });

  it("skips a listing with no resolvable handle (gone/cross-owner)", async () => {
    const { registry, kills } = makeRegistry(new Map([["s1", undefined]]));
    const { reaped } = await reapNeverTaskedDrives(registry, OWNER);
    expect(reaped).toEqual([]);
    expect(kills).toEqual([]);
  });

  it("reaps ONLY the never-tasked live drives in a mixed set", async () => {
    const { registry, kills } = makeRegistry(
      new Map([
        ["tasked", handle("tasked", true)],
        ["untasked-a", handle("untasked-a", false)],
        ["untasked-b", handle("untasked-b", false)],
      ]),
    );
    const { reaped } = await reapNeverTaskedDrives(registry, OWNER);
    expect(reaped.sort()).toEqual(["untasked-a", "untasked-b"]);
    expect(kills.sort()).toEqual(["untasked-a", "untasked-b"]);
  });

  it("empty owner (no drives) → reaps nothing (the happy path)", async () => {
    const { registry } = makeRegistry(new Map());
    expect((await reapNeverTaskedDrives(registry, OWNER)).reaped).toEqual([]);
  });

  it("a per-drive kill rejection is swallowed — the other never-tasked drives are still reaped (total)", async () => {
    const { registry, kills } = makeRegistry(
      new Map([["bad", handle("bad", false)], ["good", handle("good", false)]]),
      { killThrowsFor: "bad" },
    );
    const { reaped } = await reapNeverTaskedDrives(registry, OWNER);
    expect(reaped).toEqual(["good"]); // "bad" threw → not in reaped, but did not abort the loop
    expect(kills).toEqual(["good"]);
  });
});
