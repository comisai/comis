// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the DUR-01 recover-on-boot scan orchestrator (165-06 Task 1).
 *
 * `terminal-session-reattach.ts` is the SIBLING that keeps the 772-line registry
 * lean: it owns the recover-on-boot scan loop (the registry only CALLS it) and the
 * injected descriptor-store port. It consumes 165-01's pure `reattachDecision` —
 * NOT a second copy of the decision — and yields a typed list the registry switches
 * on (reattach → rehydrate a running handle; failed → the genuinely-gone path the
 * registry maps to the EXISTING terminal:session_state(state:"lost"), NOT a
 * non-existent `failed` event).
 *
 * Fully injected (a fake store port + a fake `isTmuxAlive`), so it is provable
 * WITHOUT a live tmux server and WITHOUT any fs. Pins the plan behaviors:
 *   - a live tmux name → a reattach action carrying the descriptor VERBATIM (I5)
 *   - a gone tmux name → a failed action (the registry preserves the journal; this
 *     module never touches it) + the content-free `tmux_session_gone` reason
 *   - a non-durable descriptor → SKIPPED (fallback_nondurable → today's lost floor)
 *   - TOTAL / never-throws: a corrupt descriptor or a throwing probe never crashes
 *     the scan (skip + continue)
 *   - rehydrateHandleFromDescriptor rebuilds a `running` handle with the SAME
 *     allowId/owner/scope/cols/rows (I5 — WHERE not WHAT)
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import {
  recoverSessionDescriptors,
  rehydrateHandleFromDescriptor,
  type SessionDescriptorStorePort,
} from "./terminal-session-reattach.js";
import type { SessionDescriptor } from "./terminal-reattach-match.js";
import * as terminalBarrel from "./index.js";

const DESC: SessionDescriptor = {
  sessionId: "abc",
  tmuxName: "comis-abc",
  allowId: "claude-drive",
  owner: { agentId: "default", sessionKey: "" },
  cols: 80,
  rows: 24,
  durable: true,
  createdAt: 1_700_000_000_000,
};

/** A fake store whose `recover()` returns the seeded descriptors verbatim. */
function fakeStore(recovered: SessionDescriptor[]): SessionDescriptorStorePort {
  return {
    persist: vi.fn(),
    recover: vi.fn(() => recovered),
    remove: vi.fn(),
  };
}

describe("recoverSessionDescriptors — the recover-on-boot scan (DUR-01)", () => {
  it("a live tmux name → a reattach action carrying the descriptor VERBATIM (I5)", () => {
    const store = fakeStore([DESC]);
    const results = recoverSessionDescriptors({ store, isTmuxAlive: (n) => n === "comis-abc" });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("reattach");
    // Identity passthrough: the SAME descriptor object, unchanged (WHERE not WHAT).
    expect(results[0]).toEqual({ action: "reattach", descriptor: DESC });
    if (results[0]!.action === "reattach") {
      expect(results[0]!.descriptor.allowId).toBe("claude-drive");
      expect(results[0]!.descriptor.owner).toEqual({ agentId: "default", sessionKey: "" });
    }
  });

  it("a gone tmux name → a failed action with the owner + content-free tmux_session_gone reason (journal kept by the caller)", () => {
    const store = fakeStore([DESC]);
    const results = recoverSessionDescriptors({ store, isTmuxAlive: () => false });
    // The failed arm carries the descriptor's owner (the agentId the registry's
    // content-free unrecoverable hook needs) + the reason — never the journal touch.
    expect(results).toEqual([
      { action: "failed", sessionId: "abc", owner: { agentId: "default", sessionKey: "" }, reason: "tmux_session_gone" },
    ]);
    // The scan NEVER removes the journal — that is the registry's preserve-on-gone contract.
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("a non-durable descriptor is SKIPPED (fallback_nondurable → today's lost floor, not re-attached)", () => {
    const nonDurable: SessionDescriptor = { ...DESC, sessionId: "nd", durable: false };
    const store = fakeStore([nonDurable]);
    const probe = vi.fn(() => true);
    const results = recoverSessionDescriptors({ store, isTmuxAlive: probe });
    // fallback_nondurable is not surfaced as a reattach/failed action — it is filtered out.
    expect(results).toEqual([]);
    // The probe is NEVER consulted for a non-durable session (it is not re-attachable).
    expect(probe).not.toHaveBeenCalled();
  });

  it("partitions a mixed batch (live → reattach, gone → failed, non-durable → skipped)", () => {
    const live: SessionDescriptor = { ...DESC, sessionId: "live", tmuxName: "comis-live" };
    const gone: SessionDescriptor = { ...DESC, sessionId: "gone", tmuxName: "comis-gone" };
    const nd: SessionDescriptor = { ...DESC, sessionId: "nd", tmuxName: "comis-nd", durable: false };
    const store = fakeStore([live, gone, nd]);
    const results = recoverSessionDescriptors({ store, isTmuxAlive: (n) => n === "comis-live" });
    expect(results).toEqual([
      { action: "reattach", descriptor: live },
      { action: "failed", sessionId: "gone", owner: gone.owner, reason: "tmux_session_gone" },
    ]);
  });

  it("TOTAL: a throwing probe never crashes the scan — that descriptor fails SAFE and the scan continues", () => {
    const a: SessionDescriptor = { ...DESC, sessionId: "a", tmuxName: "comis-a" };
    const b: SessionDescriptor = { ...DESC, sessionId: "b", tmuxName: "comis-b" };
    const store = fakeStore([a, b]);
    const probe = vi.fn((n: string) => {
      if (n === "comis-a") throw new Error("probe blew up");
      return true;
    });
    const results = recoverSessionDescriptors({ store, isTmuxAlive: probe });
    // a → failed (the SAFE direction on a throwing probe, never reattach); b → reattach.
    expect(results).toEqual([
      { action: "failed", sessionId: "a", owner: a.owner, reason: "tmux_session_gone" },
      { action: "reattach", descriptor: b },
    ]);
  });

  it("TOTAL: a throwing store.recover() yields an empty list, never an exception", () => {
    const store: SessionDescriptorStorePort = {
      persist: vi.fn(),
      recover: vi.fn(() => {
        throw new Error("disk read blew up");
      }),
      remove: vi.fn(),
    };
    expect(() => recoverSessionDescriptors({ store, isTmuxAlive: () => true })).not.toThrow();
    expect(recoverSessionDescriptors({ store, isTmuxAlive: () => true })).toEqual([]);
  });

  it("an empty durable dir yields an empty list", () => {
    const store = fakeStore([]);
    expect(recoverSessionDescriptors({ store, isTmuxAlive: () => true })).toEqual([]);
  });
});

describe("rehydrateHandleFromDescriptor — rebuild a running handle (I5 verbatim identity)", () => {
  it("rebuilds a status:'running' handle carrying allowId/owner/cols/rows VERBATIM + the durable/tmuxName fields", () => {
    const handle = rehydrateHandleFromDescriptor(DESC, 1_700_000_009_999);
    expect(handle.sessionId).toBe("abc");
    expect(handle.status).toBe("running"); // a recovered live session is running, not lost
    expect(handle.allowId).toBe("claude-drive"); // I5 — the SAME allow-entry
    expect(handle.owner).toEqual({ agentId: "default", sessionKey: "" });
    expect(handle.cols).toBe(80);
    expect(handle.rows).toBe(24);
    expect(handle.durable).toBe(true); // the durable marker rides the handle for markRunningSessionsLost
    expect(handle.tmuxName).toBe("comis-abc"); // the re-attach key the durable-aware lost branch probes
    // startedAt is rehydrated from the descriptor's createdAt (the resumed session's wall-clock cap).
    expect(handle.startedAt).toBe(1_700_000_000_000);
    // lastActivity is stamped at recover-time (the injected nowMs) so the reaper does not
    // immediately idle-evict a freshly-recovered session on a stale createdAt.
    expect(handle.lastActivity).toBe(1_700_000_009_999);
  });

  it("is owner-scoped exactly as a created handle — get/list filter on the rehydrated owner", () => {
    const other: SessionDescriptor = { ...DESC, owner: { agentId: "other", sessionKey: "k" } };
    const handle = rehydrateHandleFromDescriptor(other, 0);
    expect(handle.owner).toEqual({ agentId: "other", sessionKey: "k" });
  });
});

describe("barrel exports (skills→daemon surface for 165-07)", () => {
  it("re-exports the DUR-01 re-attach decision + the recover-on-boot seam from index.ts", () => {
    // The daemon (165-07) consumes reattachDecision/SessionDescriptor + the descriptor-store
    // port + the recover/persist helpers through the package barrel. RED on pre-patch (index.ts
    // does not yet re-export terminal-reattach-match.js / terminal-session-reattach.js).
    expect(typeof (terminalBarrel as Record<string, unknown>).reattachDecision).toBe("function");
    expect(typeof (terminalBarrel as Record<string, unknown>).serializeDescriptor).toBe("function");
    expect(typeof (terminalBarrel as Record<string, unknown>).deserializeDescriptor).toBe("function");
    expect(typeof (terminalBarrel as Record<string, unknown>).recoverSessionDescriptors).toBe("function");
    expect(typeof (terminalBarrel as Record<string, unknown>).rehydrateHandleFromDescriptor).toBe("function");
    expect(typeof (terminalBarrel as Record<string, unknown>).buildSessionDescriptor).toBe("function");
  });
});
