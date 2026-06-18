// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the learned-skill surface helper (SURFACE-01/03 + D1).
 *
 * The cache keystone: learned `<skill>` blocks append AFTER platform blocks in
 * ONE `<available_skills>` wrapper, so the per-session prompt-skills freeze
 * captures a byte-stable platform prefix (a newly-promoted skill is picked up
 * on the NEXT session, never mid-session). Materialization derives the
 * `<workspace>/.learned-skills/<name>/SKILL.md` tree WHOLESALE from `list()`
 * filtered to `active ∧ !mutating` (derive-on-refresh — a demoted skill's file
 * is gone after a refresh). Every dynamic path segment goes through `safePath`.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ok, err, type Result } from "@comis/shared";
import { safePath, type LearnedSkill, type LearnedSkillStorePort, type LearningScope } from "@comis/core";
import type { PromptSkillDescription } from "@comis/skills";
import {
  mergeLearnedSkillsXml,
  materializeLearnedSkills,
  renderLearnedSkillsXml,
  refreshLearnedSkillSurface,
  createRefreshableLearnedSkillSurface,
} from "./learned-skill-surface.js";
import { createLearnedSkillSurfaceRegistry, wireAgentLearnedSkillSurface } from "./learned-skill-surface-registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A platform PromptSkillDescription with an absolute location (as the registry produces). */
function platform(name: string): PromptSkillDescription {
  return {
    name,
    description: `desc-${name}`,
    location: `/abs/skills/${name}`,
  };
}

/** A LearnedSkill row mirror; defaults are an active, read-only procedure. */
function learned(over: Partial<LearnedSkill> = {}): LearnedSkill {
  return {
    id: `id-${over.name ?? "alpha"}`,
    name: over.name ?? "alpha",
    description: over.description ?? "an alpha procedure",
    body: over.body ?? "# Alpha\n\nStep 1. Do the thing.\n",
    trustLevel: "learned",
    state: over.state ?? "active",
    proofCount: over.proofCount ?? 3,
    confidence: over.confidence ?? 0.9,
    mutating: over.mutating ?? false,
    sourceTrajIds: over.sourceTrajIds ?? [],
    createdAt: over.createdAt ?? 1_700_000_000_000,
  };
}

/** A no-op pino-compatible logger. */
const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as import("@comis/infra").ComisLogger;

const scope: LearningScope = { tenantId: "t1", agentId: "a1" };

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(safePath(tmpdir(), "learned-surface-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mergeLearnedSkillsXml — the append-after-platform cache keystone
// ---------------------------------------------------------------------------

describe("mergeLearnedSkillsXml — append after platform", () => {
  it("renders ONE <available_skills> wrapper with platform first, then learned LAST", () => {
    const xml = mergeLearnedSkillsXml(
      [platform("P1"), platform("P2")],
      [learned({ name: "L1", description: "learned one" })],
      workDir,
    );

    // Order: P1 < P2 < L1 (learned appended last).
    const iP1 = xml.indexOf("<name>P1</name>");
    const iP2 = xml.indexOf("<name>P2</name>");
    const iL1 = xml.indexOf("<name>L1</name>");
    expect(iP1).toBeGreaterThan(-1);
    expect(iP2).toBeGreaterThan(iP1);
    expect(iL1).toBeGreaterThan(iP2);
  });

  it("emits EXACTLY ONE <available_skills> open + close tag (never two wrappers)", () => {
    const xml = mergeLearnedSkillsXml(
      [platform("P1")],
      [learned({ name: "L1" }), learned({ name: "L2", id: "id-L2" })],
      workDir,
    );
    const opens = xml.match(/<available_skills>/g) ?? [];
    const closes = xml.match(/<\/available_skills>/g) ?? [];
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });

  it("keeps the platform byte-prefix UNCHANGED when a learned skill is appended (cache-stability)", () => {
    const platformOnly = mergeLearnedSkillsXml([platform("P1"), platform("P2")], [], workDir);
    const withLearned = mergeLearnedSkillsXml(
      [platform("P1"), platform("P2")],
      [learned({ name: "L1" })],
      workDir,
    );

    // The prefix through the LAST platform </skill> must be byte-identical.
    const cut = platformOnly.indexOf("</skill>") > -1
      ? platformOnly.lastIndexOf("</skill>") + "</skill>".length
      : platformOnly.length;
    expect(withLearned.startsWith(platformOnly.slice(0, cut))).toBe(true);
  });

  it("renders <source>learned</source> on the learned block (the model-visible trust distinction)", () => {
    const xml = mergeLearnedSkillsXml([platform("P1")], [learned({ name: "L1" })], workDir);
    // Platform default source is bundled; learned explicitly carries learned.
    expect(xml).toContain("<source>learned</source>");
    // WR-02: the learned <location> is the ABSOLUTE materialized SKILL.md path —
    // consistent with platform skills (which emit metadata.path, an absolute path)
    // so the ATTR-01 attribution index (keyed on the exact <location> string the
    // model reads with) matches a `read` of that same absolute path. A relative
    // location mixed into an absolute-location block is the WR-02 attribution smell.
    const expectedAbs = safePath(workDir, ".learned-skills", "L1", "SKILL.md");
    expect(xml).toContain(`<location>${expectedAbs}</location>`);
    // It must NOT be the workspace-relative form (the pre-fix asymmetry).
    expect(xml).not.toContain("<location>.learned-skills/L1/SKILL.md</location>");
  });

  it("filters to (active|candidate) ∧ !mutating — candidate DOES surface (use-based promotion); mutating/stale/archived NEVER", () => {
    const xml = mergeLearnedSkillsXml(
      [platform("P1")],
      [
        learned({ name: "Mut", id: "id-mut", mutating: true }),
        learned({ name: "Stale", id: "id-stale", state: "stale" }),
        learned({ name: "Cand", id: "id-cand", state: "candidate" }),
        learned({ name: "Arch", id: "id-arch", state: "archived" }),
        learned({ name: "Good", id: "id-good" }),
      ],
      workDir,
    );
    expect(xml).toContain("<name>Good</name>");
    // live-2026-06-18 deadlock fix: a read-only candidate surfaces so it can be TRIED
    // and promoted candidate→active via a corroborated-success reuse.
    expect(xml).toContain("<name>Cand</name>");
    expect(xml).not.toContain("<name>Mut</name>");
    expect(xml).not.toContain("<name>Stale</name>");
    expect(xml).not.toContain("<name>Arch</name>");
  });
});

// ---------------------------------------------------------------------------
// materializeLearnedSkills — derive-on-refresh, never a stale file
// ---------------------------------------------------------------------------

describe("materializeLearnedSkills — derive wholesale", () => {
  it("writes <workspace>/.learned-skills/<name>/SKILL.md containing the body", () => {
    materializeLearnedSkills(workDir, [learned({ name: "alpha", body: "# Alpha body" })]);
    const file = safePath(workDir, ".learned-skills", "alpha", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("# Alpha body");
  });

  it("removes a demoted skill's SKILL.md on the next refresh (a second call with [])", () => {
    materializeLearnedSkills(workDir, [learned({ name: "alpha" })]);
    const file = safePath(workDir, ".learned-skills", "alpha", "SKILL.md");
    expect(existsSync(file)).toBe(true);

    // Refresh with the skill gone (demoted/archived) → its file must NOT survive.
    materializeLearnedSkills(workDir, []);
    expect(existsSync(file)).toBe(false);
  });

  it("does NOT materialize mutating or non-active skills (the surface filter holds for files too)", () => {
    materializeLearnedSkills(workDir, [
      learned({ name: "mut", mutating: true }),
      learned({ name: "stale", state: "stale" }),
      learned({ name: "ok" }),
    ]);
    expect(existsSync(safePath(workDir, ".learned-skills", "ok", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(workDir, ".learned-skills", "mut", "SKILL.md"))).toBe(false);
    expect(existsSync(safePath(workDir, ".learned-skills", "stale", "SKILL.md"))).toBe(false);
  });

  it("WR-04: one poison (path-traversal) skill name is SKIPPED — the other skills still materialize, no throw, no escape", () => {
    // A single malformed `name` (a `..` traversal that makes safePath throw) must
    // NOT abort the whole batch after the wholesale rmSync (which would leave
    // `.current` empty + a half-written subtree). Each skill is materialized under
    // its own try/catch: the bad one is dropped, the good ones survive. Pre-WR-04
    // the throw propagates out of materializeLearnedSkills → the batch is poisoned.
    expect(() =>
      materializeLearnedSkills(workDir, [
        learned({ name: "good-before" }),
        learned({ name: "../escape" }), // safePath throws on this one
        learned({ name: "good-after" }),
      ]),
    ).not.toThrow();
    // Both well-named skills are materialized (the poison one did not abort the loop).
    expect(existsSync(safePath(workDir, ".learned-skills", "good-before", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(workDir, ".learned-skills", "good-after", "SKILL.md"))).toBe(true);
    // The traversal name never escaped the workspace.
    expect(existsSync(safePath(tmpdir(), "escape", "SKILL.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderLearnedSkillsXml — the SYNC seam reader (default-off byte identity)
// ---------------------------------------------------------------------------

/** A minimal SkillRegistry stub exposing getSnapshot() (the only method the seam reads). */
function makeRegistry(descriptions: PromptSkillDescription[]) {
  const prompt =
    descriptions.length === 0
      ? ""
      : `<available_skills>\n${descriptions
          .map(
            (d) =>
              `  <skill>\n    <name>${d.name}</name>\n    <description>${d.description}</description>\n    <location>${d.location}</location>\n    <source>bundled</source>\n  </skill>`,
          )
          .join("\n")}\n</available_skills>`;
  return {
    getSnapshot: () => ({ prompt, skills: descriptions, version: 1 }),
  } as unknown as import("@comis/skills").SkillRegistry;
}

describe("renderLearnedSkillsXml — sync seam reader", () => {
  it("returns getSnapshot().prompt UNCHANGED when there are no surfaced learned skills (byte-identical)", () => {
    const reg = makeRegistry([platform("P1"), platform("P2")]);
    const out = renderLearnedSkillsXml({ skillRegistry: reg, learnedSkills: [], workspaceDir: workDir });
    expect(out).toBe(reg.getSnapshot().prompt);
  });

  it("returns getSnapshot().prompt UNCHANGED when every learned skill is filtered out (mutating/stale)", () => {
    const reg = makeRegistry([platform("P1")]);
    const out = renderLearnedSkillsXml({
      skillRegistry: reg,
      learnedSkills: [learned({ name: "mut", mutating: true }), learned({ name: "stale", state: "stale" })],
      workspaceDir: workDir,
    });
    expect(out).toBe(reg.getSnapshot().prompt);
  });

  it("appends a surfaced learned skill after the platform descriptions in one wrapper", () => {
    const reg = makeRegistry([platform("P1")]);
    const out = renderLearnedSkillsXml({
      skillRegistry: reg,
      learnedSkills: [learned({ name: "L1" })],
      workspaceDir: workDir,
    });
    expect((out.match(/<available_skills>/g) ?? []).length).toBe(1);
    expect(out.indexOf("<name>P1</name>")).toBeLessThan(out.indexOf("<name>L1</name>"));
    expect(out).toContain("<source>learned</source>");
  });
});

// ---------------------------------------------------------------------------
// refreshLearnedSkillSurface — the ASYNC half (list → materialize → cache)
// ---------------------------------------------------------------------------

/** A minimal LearnedSkillStorePort stub whose list() returns a fixed Result. */
function makeStore(listResult: Result<LearnedSkill[], Error>): LearnedSkillStorePort {
  return {
    admit: async () => ok({ id: "x", admitted: true }),
    get: async () => ok(undefined),
    list: async () => listResult,
    promote: async () => ok(undefined),
    demote: async () => ok(undefined),
    evict: async () => ok(undefined),
  } as unknown as LearnedSkillStorePort;
}

describe("refreshLearnedSkillSurface — async list + materialize + cache", () => {
  it("returns [] and materializes nothing when no store is threaded (default-off)", async () => {
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: undefined,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
    });
    expect(surfaced).toEqual([]);
    expect(existsSync(safePath(workDir, ".learned-skills"))).toBe(false);
  });

  it("materializes active∧!mutating skills and returns them when list() is ok", async () => {
    const store = makeStore(ok([learned({ name: "alpha" }), learned({ name: "mut", id: "id-mut", mutating: true })]));
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
    });
    // alpha materialized + cached; mut filtered.
    expect(existsSync(safePath(workDir, ".learned-skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(workDir, ".learned-skills", "mut", "SKILL.md"))).toBe(false);
    expect(surfaced.some((s) => s.name === "alpha")).toBe(true);
  });

  it("fails closed: list() err → returns [] and writes no learned files (no throw)", async () => {
    const store = makeStore(err(new Error("unresolved scope")));
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
    });
    expect(surfaced).toEqual([]);
    expect(existsSync(safePath(workDir, ".learned-skills", "alpha", "SKILL.md"))).toBe(false);
  });

  it("derive-on-refresh: a skill present then absent across two refreshes leaves no stale file", async () => {
    const present = makeStore(ok([learned({ name: "alpha" })]));
    await refreshLearnedSkillSurface({ learnedSkillStore: present, scope, workspaceDir: workDir, logger: noopLogger });
    const file = safePath(workDir, ".learned-skills", "alpha", "SKILL.md");
    expect(existsSync(file)).toBe(true);

    const absent = makeStore(ok([]));
    await refreshLearnedSkillSurface({ learnedSkillStore: absent, scope, workspaceDir: workDir, logger: noopLogger });
    expect(existsSync(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WR-01: createRefreshableLearnedSkillSurface — a re-refresh after a promote
// picks up the newly-active skill on the NEXT listing (SURFACE-03: it updates
// cache.current; the next freeze reads it). Without the re-refresh the boot
// snapshot is the only one a daemon ever sees → a promoted skill never surfaces.
// ---------------------------------------------------------------------------

/** A registry-backed SkillRegistry stub so renderLearnedSkillsXml can merge. */
function makeRegistryForSurface(): import("@comis/skills").SkillRegistry {
  return makeRegistry([platform("P1")]);
}

describe("WR-01: createRefreshableLearnedSkillSurface re-refresh picks up a promoted skill", () => {
  it("a promote (list() now returns the skill active) surfaces it on a subsequent refresh()", async () => {
    // list() starts empty, then returns the skill ACTIVE after a 'promote' — the
    // re-refresh picks up the new surfaceable set (SURFACE-03 next-session pickup).
    let listed: LearnedSkill[] = [];
    const store = {
      admit: async () => ok({ id: "x", admitted: true }),
      get: async () => ok(undefined),
      list: async () => ok(listed),
      promote: async () => ok(undefined),
      demote: async () => ok(undefined),
      promoteByName: async () => ok({ changed: true }),
      demoteByName: async () => ok({ changed: true }),
      evict: async () => ok(undefined),
    } as unknown as LearnedSkillStorePort;

    const reg = makeRegistryForSurface();
    const { cache, refresh } = createRefreshableLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
    });
    await refresh(); // boot-equivalent: nothing active yet
    expect(renderLearnedSkillsXml({ skillRegistry: reg, learnedSkills: cache.current, workspaceDir: workDir })).not.toContain(
      "<name>promoted-skill</name>",
    );

    // The promote happens (the skill is now active in the store) → re-refresh.
    listed = [learned({ name: "promoted-skill", state: "active" })];
    await refresh();

    // The NEXT listing now includes the promoted skill (cache.current was updated).
    const xml = renderLearnedSkillsXml({ skillRegistry: reg, learnedSkills: cache.current, workspaceDir: workDir });
    expect(xml).toContain("<name>promoted-skill</name>");
    expect(cache.current.some((s) => s.name === "promoted-skill")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WR-01: the surface registry routes a refresh(agentId) to the registered
// agent's refresh closure; an unregistered (default-off) agent is a no-op.
// ---------------------------------------------------------------------------

describe("createLearnedSkillSurfaceRegistry — per-agent refresh routing", () => {
  it("refresh(agentId) fires the registered agent's refresh closure", async () => {
    const registry = createLearnedSkillSurfaceRegistry();
    let refreshed = 0;
    registry.register("agent-A", { refresh: async () => void (refreshed += 1) });
    registry.refresh("agent-A");
    // refresh is fire-and-forget — let the microtask settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshed).toBe(1);
  });

  it("refresh(agentId) for an UNREGISTERED (default-off) agent is a no-op (never throws)", () => {
    const registry = createLearnedSkillSurfaceRegistry();
    expect(() => registry.refresh("unknown-agent")).not.toThrow();
  });

  it("unregister(agentId) drops the agent so a later refresh is a no-op", async () => {
    const registry = createLearnedSkillSurfaceRegistry();
    let refreshed = 0;
    registry.register("agent-B", { refresh: async () => void (refreshed += 1) });
    registry.unregister("agent-B");
    registry.refresh("agent-B");
    await Promise.resolve();
    expect(refreshed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WR-03: wireAgentLearnedSkillSurface gating — default-off (enabled:false) does
// ZERO surface work: NO store list(), NO .learned-skills materialize/rmSync, and
// .current is []. Enabled wires the cache + registers it.
// ---------------------------------------------------------------------------

describe("wireAgentLearnedSkillSurface — WR-03 default-off does no surface work", () => {
  it("enabled:false → no list() call, no .learned-skills dir touched, .current is []", async () => {
    let listCalls = 0;
    const store = {
      admit: async () => ok({ id: "x", admitted: true }),
      get: async () => ok(undefined),
      list: async () => {
        listCalls += 1;
        return ok([learned({ name: "would-surface", state: "active" })]);
      },
      promote: async () => ok(undefined),
      demote: async () => ok(undefined),
      promoteByName: async () => ok({ changed: true }),
      demoteByName: async () => ok({ changed: true }),
      evict: async () => ok(undefined),
    } as unknown as LearnedSkillStorePort;
    const registry = createLearnedSkillSurfaceRegistry();

    const cache = wireAgentLearnedSkillSurface({
      enabled: false, // WR-03: gated OFF
      agentId: "a1",
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      registry,
    });
    // Let any (erroneous) async boot refresh settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(listCalls).toBe(0); // NO store read when default-off
    expect(cache.current).toEqual([]); // platform-only (byte-identical)
    expect(existsSync(safePath(workDir, ".learned-skills"))).toBe(false); // NO rmSync/materialize of the dir
    // An unregistered (default-off) agent → refresh is a no-op (it never registered).
    expect(() => registry.refresh("a1")).not.toThrow();
  });

  it("enabled:true → wires the cache (boot refresh runs list()) and registers it for re-refresh", async () => {
    let listCalls = 0;
    const store = {
      admit: async () => ok({ id: "x", admitted: true }),
      get: async () => ok(undefined),
      list: async () => {
        listCalls += 1;
        return ok([learned({ name: "surfaced", state: "active" })]);
      },
      promote: async () => ok(undefined),
      demote: async () => ok(undefined),
      promoteByName: async () => ok({ changed: true }),
      demoteByName: async () => ok({ changed: true }),
      evict: async () => ok(undefined),
    } as unknown as LearnedSkillStorePort;
    const registry = createLearnedSkillSurfaceRegistry();

    const cache = wireAgentLearnedSkillSurface({
      enabled: true,
      agentId: "a1",
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      registry,
    });
    // Settle the boot refresh.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(listCalls).toBeGreaterThanOrEqual(1); // boot refresh read the store
    expect(cache.current.some((s) => s.name === "surfaced")).toBe(true);
    // Registered → a registry refresh fires the agent's closure (re-reads list()).
    const before = listCalls;
    registry.refresh("a1");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(listCalls).toBeGreaterThan(before);
  });
});
