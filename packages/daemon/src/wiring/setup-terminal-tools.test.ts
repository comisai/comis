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
 * never a throw). Phase 124-06 promotes `status` too — it is now a real,
 * classifier-backed, owner-scoped tool wired with `sharedDeps`, so the terminal-driver
 * subsystem has no remaining deferred-reject tool.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { wireTerminalTools, mapAllowEntry, buildTerminalSharedDeps, buildTerminalReaperHooks, buildTerminalEventHook } from "./setup-terminal-tools.js";
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

  it("status is IMPLEMENTED (124-06): it delegates to the per-agent registry and RESOLVES the not-found status view for an absent session (no not_implemented throw)", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const status = tools.find((t) => t.name === "terminal_session_status");
    expect(status).toBeDefined();
    // 124-06: status is a real, classifier-backed, owner-scoped tool wired with
    // sharedDeps. With an empty allow-set + no live session, registry.status degrades
    // to the not-found view (owner-scoped, never another owner's state) — it RESOLVES,
    // it does NOT throw not_implemented (a no-arg stub could not reach the registry).
    const result = (await status!.execute("call-1", { sessionId: "no-such-session" })) as {
      details: { state: string; cursorParked: boolean };
    };
    expect(result.details).toHaveProperty("state");
    expect(result.details.cursorParked).toBe(false);
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
  credentialPaths: [],
  uid: "dedicated",
};

describe("mapAllowEntry — config scope is preserved onto AllowEntryLike", () => {
  it("copies {id, match, scope} — a config scope.filesystem:'home' survives the map (NOT dropped)", () => {
    const entry = configEntry({
      filesystem: "home",
      network: "listed-hosts",
      hosts: ["api.example.com"],
      credentialPaths: ["~/.claude"],
      uid: "daemon",
    });
    const mapped = mapAllowEntry(entry);

    expect(mapped.id).toBe("bash");
    expect(mapped.match.path).toBe("/bin/bash");
    // scope MUST survive the daemon boundary.
    expect(mapped.scope.filesystem).toBe("home");
    expect(mapped.scope.network).toBe("listed-hosts");
    expect(mapped.scope.hosts).toEqual(["api.example.com"]);
    expect(mapped.scope.credentialPaths).toEqual(["~/.claude"]);
    expect(mapped.scope.uid).toBe("daemon");
  });

  it("preserves the least-privilege scope through the map (the safe default survives)", () => {
    // The config schema already default-applies least-privilege (workspace/none/
    // []-creds/dedicated — core owns + tests that). The daemon mapping must carry it
    // through UNCHANGED — never re-default or widen it.
    const mapped = mapAllowEntry(configEntry(LEAST_PRIVILEGE));

    expect(mapped.scope.filesystem).toBe("workspace");
    expect(mapped.scope.network).toBe("none");
    expect(mapped.scope.credentialPaths).toEqual([]);
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

// ===========================================================================
// 124-09 Task 1 (the keystone, TR-11 / SEC-11/12 / OPS-04) — the fd3 onTerminalEvent
// emit hook RE-PUBLISHES each worker event frame onto the daemon TypedEventBus.
// buildTerminalEventHook(agentId, deps) returns an `onTerminalEvent` closure (the
// 3rd emit-hook site, mirroring buildTerminalReaperHooks/onSpawnFailed): switch on
// frame.event, build the redaction-safe typed payload (inject agentId + timestamp,
// copy ONLY the structural fields from frame.payload), emit on deps.eventBus, log
// §2.7. The worker frame carries NO screen text (124-05) and the hook copies only
// the structural fields — so screen text physically cannot cross the bus (T-124-25).
//
// RED on pre-patch: buildTerminalEventHook does not exist (the import fails); the
// registry's onTerminalEvent dep is unbound, so a worker fd3 frame emits nothing.
// ===========================================================================

describe("buildTerminalEventHook — re-publish the fd3 frame onto the TypedEventBus (Task 1, TR-11)", () => {
  function makeEventDeps() {
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const eventBus = {
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload });
        return true;
      },
    };
    const skillsLogger = createMockLogger();
    const deps = {
      dataDir: "/tmp/comis-terminal-eventhook-test",
      skillsLogger,
      eventBus,
      sandboxProvider: {} as never,
    };
    return { deps, emitted, skillsLogger };
  }

  it("input_needed frame → emit('terminal:input_needed', {sessionId, agentId, state, reason, confidence, timestamp}) + an INFO carrying confidence", () => {
    const { deps, emitted, skillsLogger } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({
      sessionId: "s-1",
      event: "terminal:input_needed",
      payload: { state: "awaiting-input", reason: "settled_cursor_parked", confidence: "high" },
    });

    const ev = emitted.find((e) => e.event === "terminal:input_needed");
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({
      sessionId: "s-1",
      agentId: "agent-a",
      state: "awaiting-input",
      reason: "settled_cursor_parked",
      // CLASS-02: the classifier confidence rides the re-published event.
      confidence: "high",
    });
    expect(typeof ev!.payload.timestamp).toBe("number");
    // §2.7: a wake is an INFO completion-style line (step-tagged) — now carrying confidence.
    expect(skillsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-1", confidence: "high", step: "terminal_input_needed" }),
      expect.any(String),
    );
  });

  it("input_needed frame with a medium-confidence dialog detection → confidence 'medium' rides through", () => {
    const { deps, emitted } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({
      sessionId: "s-1b",
      event: "terminal:input_needed",
      payload: { state: "awaiting-input", reason: "dialog_detected", confidence: "medium" },
    });

    const ev = emitted.find((e) => e.event === "terminal:input_needed");
    expect(ev!.payload).toMatchObject({ reason: "dialog_detected", confidence: "medium" });
  });

  it("stuck frame → emit('terminal:stuck', {sessionId, agentId, noProgressMs, reason, confidence, timestamp})", () => {
    const { deps, emitted, skillsLogger } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({
      sessionId: "s-2",
      event: "terminal:stuck",
      payload: { noProgressMs: 45_000, reason: "no_progress", confidence: "medium" },
    });

    const ev = emitted.find((e) => e.event === "terminal:stuck");
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({
      sessionId: "s-2",
      agentId: "agent-a",
      noProgressMs: 45_000,
      // CLASS-02: stuck now re-publishes the classifier reason + confidence.
      reason: "no_progress",
      confidence: "medium",
    });
    expect(typeof ev!.payload.timestamp).toBe("number");
    expect(skillsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-2", reason: "no_progress", confidence: "medium", step: "terminal_stuck" }),
      expect.any(String),
    );
  });

  it("a frame whose payload OMITS confidence defaults to 'medium' on both events (defensive, mirroring the reason/state narrows) — never undefined, never a throw", () => {
    const { deps, emitted } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    // input_needed with no confidence in the (untrusted) frame payload.
    hook.onTerminalEvent({ sessionId: "s-d1", event: "terminal:input_needed", payload: { state: "awaiting-input" } });
    // stuck with no confidence/reason in the frame payload.
    hook.onTerminalEvent({ sessionId: "s-d2", event: "terminal:stuck", payload: { noProgressMs: 10_000 } });

    const inputNeeded = emitted.find((e) => e.event === "terminal:input_needed");
    expect(inputNeeded!.payload.confidence).toBe("medium");
    const stuck = emitted.find((e) => e.event === "terminal:stuck");
    expect(stuck!.payload.confidence).toBe("medium");
    expect(stuck!.payload.reason).toBe("no_progress");
  });

  it("an out-of-enum confidence on the (untrusted) frame falls back to 'medium' — never propagates raw (T-163-11)", () => {
    const { deps, emitted } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({
      sessionId: "s-d3",
      event: "terminal:input_needed",
      payload: { state: "awaiting-input", reason: "r", confidence: "ATTACKER_VALUE" },
    });

    const ev = emitted.find((e) => e.event === "terminal:input_needed");
    expect(ev!.payload.confidence).toBe("medium");
  });

  it("session_state(exited) frame → emit('terminal:session_state', {state:'exited', ...})", () => {
    const { deps, emitted } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({ sessionId: "s-3", event: "terminal:session_state", payload: { state: "exited" } });

    const ev = emitted.find((e) => e.event === "terminal:session_state");
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ sessionId: "s-3", agentId: "agent-a", state: "exited" });
  });

  it("MR-02: a worker-crash session_state(lost) frame re-publishes onto the bus → drives onSessionGone reclaim", () => {
    // The supervisor's crash path (terminal-worker-supervisor.ts) emits exactly this frame
    // shape per running session; this hook re-publishes it onto the bus, where onSessionGone
    // (setup-terminal-wake.ts) reclaims the per-session drive-state. Closes the MR-02 chain.
    const { deps, emitted } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({ sessionId: "s-crash", event: "terminal:session_state", payload: { state: "lost" } });

    const ev = emitted.find((e) => e.event === "terminal:session_state");
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ sessionId: "s-crash", agentId: "agent-a", state: "lost" });
  });

  it("escalated frame → emit('terminal:escalated', {reason, ...}) + a WARN (hint + errorKind)", () => {
    const { deps, emitted, skillsLogger } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({ sessionId: "s-4", event: "terminal:escalated", payload: { reason: "auth_login" } });

    const ev = emitted.find((e) => e.event === "terminal:escalated");
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ sessionId: "s-4", agentId: "agent-a", reason: "auth_login" });
    // §2.7: an escalation is a WARN carrying hint + errorKind.
    expect(skillsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-4", errorKind: expect.any(String) }),
      expect.any(String),
    );
  });

  it("the re-published payload is redaction-safe: a screen field on the frame payload NEVER crosses the bus (T-124-25)", () => {
    const { deps, emitted } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    // A (hypothetically) leaky worker frame carrying screen text: the hook copies ONLY
    // the structural fields, so no screen/text/payload field reaches the bus payload.
    hook.onTerminalEvent({
      sessionId: "s-5",
      event: "terminal:input_needed",
      payload: {
        state: "awaiting-input",
        reason: "settled_cursor_parked",
        confidence: "high",
        screen: "SECRET ON SCREEN",
        text: "leak",
      },
    });

    const ev = emitted.find((e) => e.event === "terminal:input_needed");
    expect(ev).toBeDefined();
    expect(ev!.payload).not.toHaveProperty("screen");
    expect(ev!.payload).not.toHaveProperty("text");
    expect(ev!.payload).not.toHaveProperty("payload");
    // The re-published key-set: structural fields + confidence (CLASS-02), no leak field.
    expect(Object.keys(ev!.payload).sort()).toEqual([
      "agentId",
      "confidence",
      "reason",
      "sessionId",
      "state",
      "timestamp",
    ]);
  });

  it("an unknown event kind is dropped (no emit) — the hook never forwards an unmodeled frame", () => {
    const { deps, emitted } = makeEventDeps();
    const hook = buildTerminalEventHook("agent-a", deps as never);

    hook.onTerminalEvent({ sessionId: "s-6", event: "terminal:not_a_real_event", payload: {} });

    expect(emitted).toHaveLength(0);
  });
});

// ===========================================================================
// 124-09 Task 3 (THE WR-01 CLOSURE, TR-06/OPS-06, T-124-28) — buildTerminalSharedDeps
// POPULATES the allow-set from the threaded operator config (was `const allowEntries =
// []`). When populated, allowEntries[0].limits feeds createSessionCaps so the per-session
// caps go LIVE; the mapped scope/approveOnCreate/limits/backend/autoAnswer/hintPatterns
// flow toward the worker + the wake-FSM (the "consume the parsed-not-consumed config" step).
//
// RED on pre-patch: TerminalWiringDeps has no `config` field; buildTerminalSharedDeps
// hardcodes `allowEntries = []`, so a threaded config is ignored (the allow-set stays
// empty + every create still fail-closes).
// ===========================================================================

describe("buildTerminalSharedDeps — the WR-01 closure: populate the allow-set from config (Task 3)", () => {
  /** A parsed TerminalDriverConfig with one allow entry carrying limits + backend. */
  function makeConfig(): TerminalAllowEntry["scope"] extends never ? never : Record<string, unknown> {
    return {
      enabled: true,
      worker: { maxSessions: 6, idleTtlMs: 120_000, ringBytes: 65_536, stuckMs: 30_000, maxConcurrentAttentionTurns: 3 },
      defaults: { cols: 80, rows: 24, scrollback: 1000 },
      allow: [
        {
          id: "claude-code",
          match: { path: "/usr/local/bin/claude" },
          scope: { filesystem: "home", network: "full", credentialPaths: ["~/.claude"], uid: "dedicated" },
          autoAnswer: "safe-only",
          hintPatterns: ["press enter to continue"],
          consent: { acknowledgedRisk: true, acknowledgedAt: "2026-06-03T00:00:00Z" },
          limits: { maxRequestsPerSession: 50, maxInteractions: 200, wallClockMs: 3_600_000 },
          backend: "tmux",
          hardening: "none",
        },
      ],
      redactSecrets: true,
      audit: { enabled: true },
    } as unknown as Record<string, unknown>;
  }

  function makeDepsWithConfig() {
    return {
      dataDir: "/tmp/comis-terminal-wr01-test",
      skillsLogger: createMockLogger(),
      eventBus: { emit: () => true },
      sandboxProvider: {} as never,
      workerCaps: { maxSessions: 6, idleTtlMs: 120_000, wallClockMs: 0, stuckMs: 30_000 },
      timers: createFakeTimers(0),
      config: makeConfig(),
    };
  }

  it("populates allowEntries from config.allow (the empty-set hardcode is GONE)", () => {
    const deps = makeDepsWithConfig();
    const registries = new Map<string, TerminalSessionRegistry>();
    const shared = buildTerminalSharedDeps(registries, "agent-a", deps as never);

    // The allow-set is now populated from the threaded config (was always []).
    expect(shared.allowEntries).toHaveLength(1);
    expect(shared.allowEntries[0]!.id).toBe("claude-code");
    // The operator scope survived the daemon-boundary map (SEC-02, no silent drop).
    expect(shared.allowEntries[0]!.scope.filesystem).toBe("home");
    expect(shared.allowEntries[0]!.limits).toMatchObject({ maxInteractions: 200 });
  });

  it("FINDING-B/DUR-01: threads config.drive.durable → sharedDeps.durable; DEFAULT-ON (tmux is the default backend), explicit opt-out respected", () => {
    // Live VPS 2026-06-16: drive.durable was parsed but NEVER threaded to the create tool (Finding B,
    // fixed). The tmux backend was then made driveable (the node-pty `attach` rework) + survive-a-restart
    // (KillMode=process + data-dir socket), so the durable/tmux path is now the DEFAULT working setup —
    // the runtime fallback flipped `?? false` → `?? true`. Explicit `durable:false` still opts out to pty.
    const registries = new Map<string, TerminalSessionRegistry>();
    const durableDeps = { ...makeDepsWithConfig(), config: { ...makeConfig(), drive: { durable: true } } };
    expect(buildTerminalSharedDeps(registries, "agent-a", durableDeps as never).durable, "drive.durable:true → true").toBe(true);
    // No drive block (the default config) → TRUE: durable/tmux is the DEFAULT backend now.
    expect(buildTerminalSharedDeps(registries, "agent-a", makeDepsWithConfig() as never).durable, "no drive block → default-on").toBe(true);
    // Explicit opt-OUT is respected → false (the non-durable pty backend).
    const optOut = { ...makeDepsWithConfig(), config: { ...makeConfig(), drive: { durable: false } } };
    expect(buildTerminalSharedDeps(registries, "agent-a", optOut as never).durable, "drive.durable:false → opt-out").toBe(false);
  });

  it("a populated allow-set with limits feeds the per-session caps (caps go LIVE)", () => {
    const deps = makeDepsWithConfig();
    const registries = new Map<string, TerminalSessionRegistry>();
    const shared = buildTerminalSharedDeps(registries, "agent-a", deps as never);
    // createSessionCaps was built from the entry limits — startSession primes the cap state,
    // then a maxInteractions-budgeted session is enforceable (the cap surface is live, not a
    // no-op default). We assert the caps instance is present + functional.
    expect(shared.caps).toBeDefined();
    expect(typeof shared.caps.startSession).toBe("function");
  });

  it("with NO config the allow-set stays empty (fail-closed default preserved)", () => {
    const deps = {
      dataDir: "/tmp/comis-terminal-wr01-empty",
      skillsLogger: createMockLogger(),
      eventBus: { emit: () => true },
      sandboxProvider: {} as never,
    };
    const registries = new Map<string, TerminalSessionRegistry>();
    const shared = buildTerminalSharedDeps(registries, "agent-a", deps as never);
    expect(shared.allowEntries).toHaveLength(0);
  });

  it("wireTerminalTools accepts config on TerminalWiringDeps and wires nine tools (no throw)", () => {
    const deps = makeDepsWithConfig();
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", deps as never);
    expect(tools).toHaveLength(9);
  });
});
