// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the terminal-driver daemon wiring (`wireTerminalTools`).
 *
 * Asserts the composition root pushes all nine never-export terminal tools onto
 * the agent tool array, reuses one registry per agent, and is fail-closed by
 * construction at this phase: the wired allow-set is empty, so a create on the
 * wired tool rejects with `permission_denied` before any worker is spawned
 * (SEC-01). Imports the real `@comis/skills/tools` factories (resolved from the
 * built `dist`).
 *
 * After Phase 120 the four interaction tools (send_text/send_key/wait/resize) are
 * IMPLEMENTED factories the wiring constructs with `sharedDeps` (they receive the
 * per-agent registry), so they no longer reject `not_implemented` — they delegate
 * to the registry (which, with no live session, degrades to a resolved gone-shape,
 * never a throw). `status` is the LONE remaining stub that still rejects
 * `not_implemented`.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { wireTerminalTools, mapAllowEntry } from "./setup-terminal-tools.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import type { TerminalSessionRegistry } from "@comis/skills/tools";
import type { TerminalAllowEntry } from "@comis/core";

type ToolLike = { name: string; execute: (id: string, params: object) => Promise<unknown> };

function makeDeps() {
  return {
    dataDir: "/tmp/comis-terminal-wiring-test",
    skillsLogger: createMockLogger(),
    eventBus: { emit: () => true },
    // MR-03: the daemon's once-detected cached provider (a present sentinel here;
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

  it("is fail-closed: a create on the empty allow-set rejects permission_denied, no spawn (SEC-01)", async () => {
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
    // session the registry degrades to a resolved gone-shape (the 120-03
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

  it("status is the LONE remaining stub — it still rejects not_implemented (Phase 124)", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const status = tools.find((t) => t.name === "terminal_session_status");
    expect(status).toBeDefined();
    await expect(status!.execute("call-1", { sessionId: "s" })).rejects.toThrow(/\[not_implemented\]/);
  });
});

// ===========================================================================
// 122-01 Task 3 — config -> AllowEntryLike scope mapping (SEC-02/03). The single
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
function configEntry(scope: TerminalAllowEntry["scope"]): TerminalAllowEntry {
  return {
    id: "bash",
    match: { path: "/bin/bash" },
    scope,
    autoAnswer: "safe-only",
    consent: { acknowledgedRisk: true, acknowledgedAt: "2026-06-03T00:00:00Z" },
    hardening: "none",
  };
}

/** The least-privilege scope the schema materializes when sub-fields are omitted. */
const LEAST_PRIVILEGE: TerminalAllowEntry["scope"] = {
  filesystem: "workspace",
  network: "none",
  credentialHome: "exclude",
  uid: "dedicated",
};

describe("mapAllowEntry — config scope is preserved onto AllowEntryLike (SEC-02/03)", () => {
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
    // RESEARCH Pitfall 4: scope MUST survive the daemon boundary.
    expect(mapped.scope.filesystem).toBe("home");
    expect(mapped.scope.network).toBe("listed-hosts");
    expect(mapped.scope.hosts).toEqual(["api.example.com"]);
    expect(mapped.scope.credentialHome).toBe("include");
    expect(mapped.scope.uid).toBe("daemon");
  });

  it("preserves the least-privilege scope through the map (the safe default survives)", () => {
    // The config schema already default-applies least-privilege (workspace/none/
    // exclude/dedicated — core owns + tests that). The daemon mapping must carry it
    // through UNCHANGED — never re-default or widen it (SEC-03).
    const mapped = mapAllowEntry(configEntry(LEAST_PRIVILEGE));

    expect(mapped.scope.filesystem).toBe("workspace");
    expect(mapped.scope.network).toBe("none");
    expect(mapped.scope.credentialHome).toBe("exclude");
    expect(mapped.scope.uid).toBe("dedicated");
  });

  it("is the single mapping site: the mapped entry feeds matchAllowEntry's AllowEntryLike shape unchanged", () => {
    // Structural proof the mapping yields the exact AllowEntryLike contract the
    // skills matcher consumes ({id, match, scope}) — so a later config-plumbing step
    // can do allowEntries = config.allow.map(mapAllowEntry) and scope flows.
    const mapped = mapAllowEntry(configEntry(LEAST_PRIVILEGE));
    expect(Object.keys(mapped).sort()).toEqual(["id", "match", "scope"]);
  });
});

describe("wireTerminalTools — still fail-closed at this phase (config not yet threaded)", () => {
  it("the WIRED allow-set stays empty, so a create still fail-closes (the 119-04 invariant holds)", async () => {
    // mapAllowEntry exists, but the wiring does NOT yet populate allowEntries from
    // config (that config-plumbing is a later step). The wired set is empty → every
    // create rejects before any spawn — SEC-01/16 unchanged.
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());
    const createTool = tools.find((t) => t.name === "terminal_session_create");
    await expect(
      createTool!.execute("call-1", { allowId: "bash", command: "/bin/bash" }),
    ).rejects.toThrow(/\[permission_denied\]/);
  });
});
