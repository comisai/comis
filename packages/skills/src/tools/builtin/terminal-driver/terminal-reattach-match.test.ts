// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure DUR-01 re-attach decision
 * (terminal-reattach-match.ts) — Phase 165, CONTEXT §7.1.5 / design §4 Phase C.
 *
 * RED-first: `terminal-reattach-match.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns them
 * GREEN. (Mirrors terminal-drive-journal.test.ts:6-9 / terminal-dialog-detector.test.ts
 * — the "module does not exist on first commit" banner.)
 *
 * The load-bearing finding of Phase 165 is that the tmux re-attach MECHANISM already
 * ships (terminal-tmux-backend.ts derives `comis-<id>`, has-session-gates create-vs-
 * reattach, terminal-tmux-backend.linux.test.ts proves survival). The genuine gap is one
 * layer up: the registry's `sessionId` is an ephemeral `randomUUID()` it never persists,
 * so on a daemon restart its `sessions` Map is empty and a healthy 38h drive whose
 * `comis-<old-id>` is STILL alive under tmux is wrongly flipped `lost`. This module is the
 * PURE, total, infra-free decision the registry's recover-on-boot (165-06) consumes:
 * given a persisted descriptor + a live `has-session` probe, decide `reattach` (alive) /
 * `failed` (gone) / `fallback_nondurable` (not durable). It rebuilds NO tmux mechanism.
 *
 * The five load-bearing behaviors this file pins (plan 165-01):
 *   - A durable descriptor whose tmux name is LIVE → `reattach` (I10 survive-restart: a
 *     40h drive crosses the daemon's lifetime + is never lost).
 *   - A durable descriptor whose tmux name is GONE → `failed` / `tmux_session_gone` (I10 —
 *     a genuine death surfaces, the journal is preserved SEPARATELY by the caller, NOT
 *     deleted here; never a silent restart, never a double-drive).
 *   - A `durable:false` descriptor → `fallback_nondurable` SHORT-CIRCUIT (I1 — today's
 *     lost floor for a non-durable spawn session; the probe is NEVER consulted).
 *   - TOTAL / never-throws (the SAFE direction, I10): a degenerate descriptor (missing /
 *     empty `tmuxName`) OR a probe that THROWS → `failed`, NEVER `reattach`. A false
 *     `reattach` would double-drive; on ANY doubt the decision fails safe.
 *   - The I5 identity passthrough: the descriptor carries `allowId`/`owner`/`scope` and the
 *     `reattach` action returns them UNCHANGED — the decision NEVER derives or widens the
 *     allow-entry/jail/uid (durability changes WHERE, never WHAT). A later 165-06 RED test
 *     asserts the re-stamped allow-entry equals the original; here we pin the verbatim
 *     passthrough at the source.
 *
 * Plus the durable round-trip: `serializeDescriptor`/`deserializeDescriptor` round-trips a
 * populated descriptor; a malformed/partial/non-object/invalid-JSON input → a deserialize
 * that returns `undefined` and NEVER throws (mirrors `deserializeJournal`,
 * terminal-drive-journal.ts:283-318 — a corrupt-after-crash file is a corrupt-SKIP, never
 * a partially-trusted object).
 *
 * The probe is an INJECTED `isTmuxAlive: (name) => boolean` fake — NO live tmux, NO real
 * process (the exact idiom of terminal-tmux-backend.test.ts:197-209's `vi.fn(() => true)`).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import {
  reattachDecision,
  serializeDescriptor,
  deserializeDescriptor,
  type SessionDescriptor,
} from "./terminal-reattach-match.js";

// ---------------------------------------------------------------------------
// A local factory for the descriptor under test (AGENTS.md §2.6 — make<X> at top).
// Neutral placeholders only (no real ids/secrets). `comis-abc` mirrors
// tmuxSessionName("abc") so the live-name probe matches the shipped naming scheme.
// ---------------------------------------------------------------------------
function makeDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    sessionId: "abc",
    tmuxName: "comis-abc",
    allowId: "claude-drive",
    owner: { agentId: "default", sessionKey: "" },
    scope: {
      filesystem: "workspace",
      network: "none",
      credentialPaths: [],
      uid: "dedicated",
    },
    cols: 80,
    rows: 24,
    durable: true,
    createdAt: 0,
    ...overrides,
  };
}

describe("terminal-reattach-match — reattachDecision (the DUR-01 re-attach decision, pure/total)", () => {
  it("re-attaches (NOT lost) when the durable session's tmux name survived the restart (I10)", () => {
    const desc = makeDescriptor();
    const isTmuxAlive = vi.fn((name: string) => name === "comis-abc"); // has-session true
    const r = reattachDecision(desc, isTmuxAlive);

    expect(r.action).toBe("reattach");
    // RECUR-03: probes the deterministic name AND the session's per-boot socket (undefined here —
    // this fixture has no tmuxSocket, so the probe falls back to its default socket).
    expect(isTmuxAlive).toHaveBeenCalledWith("comis-abc", undefined);
  });

  it("fails a genuinely-gone durable session as tmux_session_gone (journal preserved by caller, I10)", () => {
    const desc = makeDescriptor();
    const r = reattachDecision(desc, () => false); // has-session false → genuinely gone

    expect(r).toEqual({ action: "failed", sessionId: "abc", reason: "tmux_session_gone" });
  });

  it("short-circuits a non-durable (spawn) descriptor to fallback_nondurable WITHOUT probing (I1)", () => {
    const desc = makeDescriptor({ durable: false });
    const isTmuxAlive = vi.fn(() => true);
    const r = reattachDecision(desc, isTmuxAlive);

    expect(r).toEqual({ action: "fallback_nondurable", sessionId: "abc" });
    // The probe is the lost-floor short-circuit's whole point: a non-durable session is
    // never re-attached, so its liveness is irrelevant and is NEVER consulted.
    expect(isTmuxAlive).not.toHaveBeenCalled();
  });

  it("returns the I5 identity (allowId/owner/scope) UNCHANGED on the reattach action (WHERE not WHAT)", () => {
    // A distinct identity so an accidental derive/widen would be visible.
    const desc = makeDescriptor({
      sessionId: "sess-xyz",
      tmuxName: "comis-sess-xyz",
      allowId: "codex-drive",
      owner: { agentId: "mldag", sessionKey: "channel:room-7" },
      scope: {
        filesystem: "listed-paths",
        paths: ["/srv/project"],
        network: "listed-hosts",
        hosts: ["api.internal"],
        credentialPaths: ["~/.codex"],
        uid: "dedicated",
      },
    });
    const r = reattachDecision(desc, () => true);

    expect(r.action).toBe("reattach");
    if (r.action !== "reattach") throw new Error("expected reattach"); // narrow for the type guard
    // The decision passes the descriptor through VERBATIM — it never re-derives identity.
    expect(r.descriptor).toBe(desc); // same reference (no clone, no field-by-field rebuild)
    expect(r.descriptor.allowId).toBe("codex-drive");
    expect(r.descriptor.owner).toEqual({ agentId: "mldag", sessionKey: "channel:room-7" });
    expect(r.descriptor.scope).toEqual(desc.scope);
  });

  it("fails SAFE (never re-attaches) when the liveness probe THROWS — a false reattach double-drives (I10)", () => {
    const desc = makeDescriptor();
    const throwingProbe = (): boolean => {
      throw new Error("tmux binary missing");
    };
    const r = reattachDecision(desc, throwingProbe);

    // The SAFE direction: on a probe fault we declare `failed`, never `reattach` — a
    // false `reattach` would spawn a second CLI against a session we cannot confirm.
    expect(r).toEqual({ action: "failed", sessionId: "abc", reason: "tmux_session_gone" });
  });

  it("fails a degenerate durable descriptor with a missing/empty tmuxName (never probes a falsy name)", () => {
    const desc = makeDescriptor({ tmuxName: "" });
    const isTmuxAlive = vi.fn(() => true); // even a 'true' probe must not rescue an unnamed session
    const r = reattachDecision(desc, isTmuxAlive);

    expect(r.action).toBe("failed");
    if (r.action !== "failed") throw new Error("expected failed");
    expect(r.reason).toBe("tmux_session_gone");
    expect(isTmuxAlive).not.toHaveBeenCalledWith(""); // never probe a falsy name
  });

  it("never throws on a wholly-degenerate descriptor (undefined-ish) — yields the SAFE failed shape", () => {
    // The registry's recover loop must survive a corrupt-after-crash descriptor; the
    // decision is TOTAL even for an input that is not a well-formed descriptor.
    const degenerate = {} as unknown as SessionDescriptor;
    expect(() => reattachDecision(degenerate, () => true)).not.toThrow();
    const r = reattachDecision(degenerate, () => true);
    // No `durable` ⇒ falls to the non-durable short-circuit OR the failed shape; either
    // way it is a defined, safe, non-`reattach` action (never a wrong re-attach).
    expect(r.action).not.toBe("reattach");
  });
});

describe("terminal-reattach-match — serialize/deserialize round-trip (the durable recovery contract)", () => {
  it("round-trips a fully-populated descriptor through serialize → deserialize unchanged", () => {
    const desc = makeDescriptor({
      sessionId: "sess-rt",
      tmuxName: "comis-sess-rt",
      allowId: "gemini-drive",
      owner: { agentId: "default", sessionKey: "channel:abc" },
      scope: {
        filesystem: "home",
        network: "full",
        credentialPaths: ["~/.gemini"],
        uid: "daemon",
      },
      cols: 120,
      rows: 40,
      durable: true,
      createdAt: 1_700_000_000_000,
    });
    const round = deserializeDescriptor(serializeDescriptor(desc));

    expect(round).toEqual(desc);
  });

  // RECUR-03 (option A, per-generation tmux server): a durable session is created on a PER-BOOT
  // socket so a daemon restart's NEW sessions get a fresh server in the live mount namespace while
  // the surviving durable one re-attaches from its OWN (prior-boot) socket and keeps running. The
  // socket is persisted ON the descriptor so recover-on-boot probes/attaches the RIGHT server.
  it("round-trips the per-session tmuxSocket (RECUR-03 — the per-boot server the session lives on)", () => {
    const desc = makeDescriptor({ sessionId: "rt-sock", tmuxName: "comis-rt-sock", tmuxSocket: "/data/x/terminal-worker/tmux-77.sock" });
    const round = deserializeDescriptor(serializeDescriptor(desc));
    expect(round).toEqual(desc);
    expect(round?.tmuxSocket).toBe("/data/x/terminal-worker/tmux-77.sock");
  });

  it("a legacy descriptor with NO tmuxSocket still deserializes (optional — pre-RECUR-03 / non-durable falls back to the boot socket)", () => {
    const desc = makeDescriptor({ sessionId: "rt-legacy" });
    delete (desc as { tmuxSocket?: string }).tmuxSocket;
    const round = deserializeDescriptor(serializeDescriptor(desc));
    expect(round).toBeDefined();
    expect(round?.tmuxSocket).toBeUndefined();
  });

  it("REJECTS a non-string tmuxSocket (a smuggled-after-crash socket must not reach the probe)", () => {
    const bad = { ...makeDescriptor(), tmuxSocket: 42 };
    expect(deserializeDescriptor(bad)).toBeUndefined();
  });

  it("accepts an already-parsed object (DUR-01 recover-on-boot may hand a parsed value)", () => {
    const desc = makeDescriptor();
    // Pass the object directly (not a JSON string) — the registry may deserialize once.
    const round = deserializeDescriptor({ ...desc });

    expect(round).toEqual(desc);
  });

  it("returns undefined (never throws) on invalid JSON — a corrupt-after-crash file is a skip", () => {
    expect(deserializeDescriptor("{ not valid json ::")).toBeUndefined();
  });

  it("returns undefined on a non-object payload (null / number / array carries no fields)", () => {
    expect(deserializeDescriptor(null)).toBeUndefined();
    expect(deserializeDescriptor(42)).toBeUndefined();
    expect(deserializeDescriptor("[1,2,3]")).toBeUndefined();
    expect(deserializeDescriptor(undefined)).toBeUndefined();
  });

  it("returns undefined on a partial descriptor missing a required field (corrupt-skip, never partial-trust)", () => {
    const { tmuxName: _omit, ...partial } = makeDescriptor();
    // A descriptor with no tmuxName is unusable for re-attach → reject rather than
    // hand the registry a half-trusted object (mirrors deserializeJournal's discipline,
    // but rejecting rather than defaulting — a missing identity field is unrecoverable).
    expect(deserializeDescriptor(partial)).toBeUndefined();
  });

  it("returns undefined when a field has the wrong primitive type (e.g. cols as a string)", () => {
    const bad = { ...makeDescriptor(), cols: "80" as unknown as number };
    expect(deserializeDescriptor(bad)).toBeUndefined();
  });

  it("returns undefined when owner is malformed (missing agentId) — the I5 identity must be intact", () => {
    const bad = { ...makeDescriptor(), owner: { sessionKey: "" } as unknown as SessionDescriptor["owner"] };
    expect(deserializeDescriptor(bad)).toBeUndefined();
  });

  it("round-trips a listed-paths/listed-hosts scope (I5 — the optional paths/hosts arrays survive recover-on-boot)", () => {
    // A durable drive with a listed-paths filesystem + listed-hosts network posture: the
    // optional scope.paths/scope.hosts string arrays are load-bearing AUTHORIZATION (I5) and
    // MUST round-trip intact through persist → recover-on-boot (exercises the isScope
    // paths/hosts element validators that a workspace/none scope never reaches).
    const desc = makeDescriptor({
      scope: {
        filesystem: "listed-paths",
        network: "listed-hosts",
        credentialPaths: ["~/.aws/credentials"],
        uid: "dedicated",
        paths: ["/work/repo", "/work/cache"],
        hosts: ["api.example.com", "registry.example.com"],
      },
    });
    const round = deserializeDescriptor(serializeDescriptor(desc));

    expect(round).toEqual(desc);
    expect(round?.scope.paths).toEqual(["/work/repo", "/work/cache"]);
    expect(round?.scope.hosts).toEqual(["api.example.com", "registry.example.com"]);
  });

  it("rejects a scope whose paths or hosts array carries a non-string element (corrupt-skip — I5 identity must be well-typed)", () => {
    const badPaths = {
      ...makeDescriptor(),
      scope: { filesystem: "listed-paths", network: "none", credentialPaths: [], uid: "dedicated", paths: ["/ok", 42 as unknown as string] },
    };
    expect(deserializeDescriptor(badPaths)).toBeUndefined();
    const badHosts = {
      ...makeDescriptor(),
      scope: { filesystem: "workspace", network: "listed-hosts", credentialPaths: [], uid: "dedicated", hosts: ["ok.example.com", 7 as unknown as string] },
    };
    expect(deserializeDescriptor(badHosts)).toBeUndefined();
  });
});
