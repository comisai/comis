// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the terminal-driver daemon wiring (`wireTerminalTools`).
 *
 * Asserts the composition root pushes all nine never-export terminal tools onto
 * the agent tool array, reuses one registry per agent, and is fail-closed by
 * construction at this phase: the wired allow-set is empty, so a create on the
 * wired tool rejects with `permission_denied` before any worker is spawned.
 * Imports the real `@comis/skills/tools` factories (resolved from the
 * built `dist`).
 *
 * The four interaction tools (send_text/send_key/wait/resize) are
 * IMPLEMENTED factories the wiring constructs with `sharedDeps` (they receive the
 * per-agent registry), so they no longer reject `not_implemented` — they delegate
 * to the registry (which, with no live session, degrades to a resolved gone-shape,
 * never a throw). `status` is the LONE remaining stub that still rejects
 * `not_implemented`.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { wireTerminalTools, mapAllowEntry, buildTerminalSharedDeps, buildTerminalReaperHooks } from "./setup-terminal-tools.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import type { TerminalSessionRegistry } from "@comis/skills/tools";
import type { TerminalAllowEntry, EgressControlPort } from "@comis/core";

type ToolLike = { name: string; execute: (id: string, params: object) => Promise<unknown> };

function makeDeps() {
  return {
    dataDir: "/tmp/comis-terminal-wiring-test",
    skillsLogger: createMockLogger(),
    eventBus: { emit: () => true },
    // The daemon's once-detected cached provider (a present sentinel here;
    // the empty allow-set still fail-closes every create before it is consulted).
    sandboxProvider: {} as never,
  };
}

const NINE_NAMES = [
  "terminal_session_create",
  "terminal_session_read",
  "terminal_session_list",
  "terminal_session_kill",
  "terminal_session_send_text",
  "terminal_session_send_key",
  "terminal_session_wait",
  "terminal_session_status",
  "terminal_session_resize",
];

describe("wireTerminalTools — daemon composition root", () => {
  it("pushes all nine never-export terminal tools onto the agent tool array", () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const names = tools.map((t) => t.name);
    for (const expected of NINE_NAMES) {
      expect(names).toContain(expected);
    }
    expect(tools).toHaveLength(9);
  });

  it("reuses one registry per agent (lazy, closure-local map)", () => {
    const registries = new Map<string, TerminalSessionRegistry>();
    const deps = makeDeps();
    wireTerminalTools([] as never, registries, "agent-a", deps);
    wireTerminalTools([] as never, registries, "agent-a", deps);
    wireTerminalTools([] as never, registries, "agent-b", deps);
    // One registry for agent-a (reused), one for agent-b.
    expect(registries.size).toBe(2);
  });

  it("is fail-closed: a create on the empty allow-set rejects permission_denied, no spawn", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const createTool = tools.find((t) => t.name === "terminal_session_create");
    expect(createTool).toBeDefined();
    // The wired allow-set is empty → the allowlist gate rejects before any spawn.
    await expect(
      createTool!.execute("call-1", { allowId: "bash", command: "/bin/bash" }),
    ).rejects.toThrow(/\[permission_denied\]/);
  });

  it("the four interaction tools are IMPLEMENTED (delegate to the registry; do NOT reject not_implemented)", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    // The four interaction tools now reach the injected registry. With no live
    // session the registry degrades to a resolved gone-shape (the
    // degrade-not-hang posture) — they RESOLVE, they do NOT throw not_implemented.
    // (Pre-GREEN the wiring passed no-arg stubs, so this asserts the sharedDeps
    // injection: a no-arg factory would have no registry to delegate to.)
    const interaction = ["terminal_session_send_text", "terminal_session_send_key", "terminal_session_resize", "terminal_session_wait"];
    for (const name of interaction) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} should be wired`).toBeDefined();
      await expect(
        tool!.execute("call-1", { sessionId: "no-such-session", text: "x", keys: ["C-c"], cols: 80, rows: 24 }),
        `${name} should delegate to the registry, not reject not_implemented`,
      ).resolves.toBeDefined();
    }
  });

  it("send_text delegates to the per-agent registry and resolves the degraded {screen,cursor} for an absent session", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const sendText = tools.find((t) => t.name === "terminal_session_send_text");
    const result = (await sendText!.execute("call-1", { sessionId: "no-such-session", text: "hi" })) as {
      details: { screen: string; cursor: { x: number; y: number } };
    };
    // The registry's degrade-on-absent-session shape (no worker spawned; empty
    // allow-set) — a resolved {screen,cursor}, proving the sharedDeps registry
    // was injected (a no-arg stub factory could not produce this).
    expect(result.details).toHaveProperty("screen");
    expect(result.details).toHaveProperty("cursor");
  });

  it("status is the LONE remaining stub — it still rejects not_implemented", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const status = tools.find((t) => t.name === "terminal_session_status");
    expect(status).toBeDefined();
    await expect(status!.execute("call-1", { sessionId: "s" })).rejects.toThrow(/\[not_implemented\]/);
  });
});

// ===========================================================================
// config -> AllowEntryLike scope mapping. The single
// site config scope becomes an AllowEntryLike, so the later config-plumbing step
// (mapAllowEntries(config.allow)) threads scope automatically — no silent drop.
// ===========================================================================

/**
 * Build a single PARSED allow entry (a `TerminalAllowEntry` — what `mapAllowEntry`
 * receives at runtime, AFTER the config schema has parsed + default-applied it). The
 * scope here is already fully materialized (the schema's `.default(...)` semantics
 * are owned + tested by core's `schema-skills.test.ts`); these tests assert the
 * daemon-boundary MAPPING preserves whatever scope arrives, not the defaulting.
 */
function configEntry(
  scope: TerminalAllowEntry["scope"],
  approveOnCreate?: boolean,
): TerminalAllowEntry {
  return {
    id: "bash",
    match: { path: "/bin/bash" },
    scope,
    autoAnswer: "safe-only",
    consent: { acknowledgedRisk: true, acknowledgedAt: "2026-06-03T00:00:00Z" },
    hardening: "none",
    ...(approveOnCreate === undefined ? {} : { approveOnCreate }),
  };
}

/** The least-privilege scope the schema materializes when sub-fields are omitted. */
const LEAST_PRIVILEGE: TerminalAllowEntry["scope"] = {
  filesystem: "workspace",
  network: "none",
  credentialHome: "exclude",
  uid: "dedicated",
};

describe("mapAllowEntry — config scope is preserved onto AllowEntryLike", () => {
  it("copies {id, match, scope} — a config scope.filesystem:'home' survives the map (NOT dropped)", () => {
    const entry = configEntry({
      filesystem: "home",
      network: "listed-hosts",
      hosts: ["api.example.com"],
      credentialHome: "include",
      uid: "daemon",
    });
    const mapped = mapAllowEntry(entry);

    expect(mapped.id).toBe("bash");
    expect(mapped.match.path).toBe("/bin/bash");
    // scope MUST survive the daemon boundary.
    expect(mapped.scope.filesystem).toBe("home");
    expect(mapped.scope.network).toBe("listed-hosts");
    expect(mapped.scope.hosts).toEqual(["api.example.com"]);
    expect(mapped.scope.credentialHome).toBe("include");
    expect(mapped.scope.uid).toBe("daemon");
  });

  it("preserves the least-privilege scope through the map (the safe default survives)", () => {
    // The config schema already default-applies least-privilege (workspace/none/
    // exclude/dedicated — core owns + tests that). The daemon mapping must carry it
    // through UNCHANGED — never re-default or widen it.
    const mapped = mapAllowEntry(configEntry(LEAST_PRIVILEGE));

    expect(mapped.scope.filesystem).toBe("workspace");
    expect(mapped.scope.network).toBe("none");
    expect(mapped.scope.credentialHome).toBe("exclude");
    expect(mapped.scope.uid).toBe("dedicated");
  });

  it("is the single mapping site: the mapped entry feeds matchAllowEntry's AllowEntryLike shape unchanged", () => {
    // Structural proof the mapping yields the exact AllowEntryLike contract the
    // skills matcher consumes ({id, match, scope, approveOnCreate, limits}) — so a
    // later config-plumbing step can do allowEntries = config.allow.map(mapAllowEntry)
    // and scope + the consent flag + the caps flow.
    const mapped = mapAllowEntry(configEntry(LEAST_PRIVILEGE));
    expect(Object.keys(mapped).sort()).toEqual(["approveOnCreate", "id", "limits", "match", "scope"]);
  });

  it("copies approveOnCreate so the consent flag survives the daemon boundary (NOT dropped)", () => {
    // approveOnCreate is a sibling of scope — the create tool gates on it.
    // The daemon mapping MUST carry it through, else a high-risk entry silently
    // skips the operator approval gate.
    const mappedTrue = mapAllowEntry(configEntry(LEAST_PRIVILEGE, true));
    expect(mappedTrue.approveOnCreate).toBe(true);

    const mappedUnset = mapAllowEntry(configEntry(LEAST_PRIVILEGE));
    expect(mappedUnset.approveOnCreate).toBeUndefined();
  });
});

// ===========================================================================
// Thread the EgressControlPort impl + the resolved bwrapPath
// through TerminalWiringDeps -> the worker path (so the worker can compose them
// for network:listed-hosts). The live relay-as-init EXECUTION is VPS-only;
// here we assert the PORT + the bwrapPath are carried through the seam.
// ===========================================================================

describe("wireTerminalTools — threads egressControl + bwrapPath toward the worker", () => {
  function makeEgressDeps() {
    const egressControl: EgressControlPort = {
      materialize: vi.fn(async (hosts: string[]) => ({
        socketPath: `/tmp/egress-${hosts.length}.sock`,
        dispose: vi.fn(async () => {}),
      })),
    };
    return {
      dataDir: "/tmp/comis-terminal-egress-test",
      skillsLogger: createMockLogger(),
      eventBus: { emit: () => true },
      sandboxProvider: {} as never,
      egressControl,
      bwrapPath: "/usr/bin/bwrap",
    };
  }

  it("accepts egressControl + bwrapPath on TerminalWiringDeps and wires nine tools (no throw)", () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    // The deps interface must accept the two new fields (compile-time + runtime).
    wireTerminalTools(tools as never, registries, "agent-a", makeEgressDeps());
    expect(tools).toHaveLength(9);
  });

  it("buildTerminalSharedDeps carries the EgressControlPort instance + bwrapPath through to the worker path", () => {
    const deps = makeEgressDeps();
    const registries = new Map<string, TerminalSessionRegistry>();
    // The shared-deps builder is the single seam where the port + bwrapPath flow
    // toward the registry/worker. Assert the SAME instances thread through (so the
    // worker can call materialize for listed-hosts + pass bwrapPath to
    // buildScopeArgs).
    const shared = buildTerminalSharedDeps(registries, "agent-a", deps);
    expect(shared.egressControl).toBe(deps.egressControl);
    expect(shared.bwrapPath).toBe("/usr/bin/bwrap");
  });
});

describe("wireTerminalTools — still fail-closed at this phase (config not yet threaded)", () => {
  it("the WIRED allow-set stays empty, so a create still fail-closes", async () => {
    // mapAllowEntry exists, but the wiring does NOT yet populate allowEntries from
    // config (that config-plumbing is a later step). The wired set is empty → every
    // create rejects before any spawn — the fail-closed posture is unchanged.
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());
    const createTool = tools.find((t) => t.name === "terminal_session_create");
    await expect(
      createTool!.execute("call-1", { allowId: "bash", command: "/bin/bash" }),
    ).rejects.toThrow(/\[permission_denied\]/);
  });
});

// ===========================================================================
// The daemon wires the reaper eviction audit. The
// onEvict hook emits terminal:session_evicted (reason) + terminal:session_state
// (state lost) + a WARN log (hint + errorKind resource); onCapForget is wired to
// caps.forget; worker.{maxSessions,idleTtlMs} + the entry limits.wallClockMs +
// the TimerPort thread into the registry's reaper deps.
//
// RED on pre-patch: buildTerminalReaperHooks does not exist; TerminalWiringDeps
// has no workerCaps/timers/caps; the shared deps do not carry them.
// ===========================================================================

describe("buildTerminalReaperHooks — the daemon eviction audit", () => {
  function makeReaperDeps() {
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const eventBus = { emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); return true; } };
    const caps = { forget: vi.fn(), startSession: vi.fn(), consumeRequest: vi.fn(), consumeInteraction: vi.fn(), checkWallClock: vi.fn() };
    const skillsLogger = createMockLogger();
    const deps = {
      dataDir: "/tmp/comis-terminal-reaper-test",
      skillsLogger,
      eventBus,
      sandboxProvider: {} as never,
      workerCaps: { maxSessions: 4, idleTtlMs: 60_000, wallClockMs: 0, stuckMs: 30_000 },
      timers: createFakeTimers(0),
      caps,
    };
    return { deps, emitted, caps, skillsLogger };
  }

  it("onEvict emits terminal:session_evicted (reason) + terminal:session_state (lost) + a WARN log", () => {
    const { deps, emitted, skillsLogger } = makeReaperDeps();
    const hooks = buildTerminalReaperHooks("agent-a", deps as never);

    hooks.onEvict({ sessionId: "s-1", reason: "idle", durationMs: 1234 });

    const evicted = emitted.find((e) => e.event === "terminal:session_evicted");
    expect(evicted).toBeDefined();
    expect(evicted!.payload).toMatchObject({ sessionId: "s-1", agentId: "agent-a", reason: "idle", durationMs: 1234 });

    const state = emitted.find((e) => e.event === "terminal:session_state");
    expect(state).toBeDefined();
    expect(state!.payload).toMatchObject({ sessionId: "s-1", agentId: "agent-a", state: "lost", durationMs: 1234 });

    // The audited WARN carries the reason as hint + errorKind resource.
    expect(skillsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-1", agentId: "agent-a", reason: "idle", errorKind: "resource" }),
      expect.any(String),
    );
  });

  it("onCapForget is wired to caps.forget (the cap-state map is dropped on the reap path)", () => {
    const { deps, caps } = makeReaperDeps();
    const hooks = buildTerminalReaperHooks("agent-a", deps as never);

    hooks.onCapForget("s-2");

    expect(caps.forget).toHaveBeenCalledWith("s-2");
  });

  it("wireTerminalTools accepts workerCaps + timers + caps on TerminalWiringDeps and wires nine tools (no throw)", () => {
    const { deps } = makeReaperDeps();
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", deps as never);
    expect(tools).toHaveLength(9);
  });
});
