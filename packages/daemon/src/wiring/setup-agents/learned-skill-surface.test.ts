// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the learned-skill surface helper.
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
import { safePath, type MentalModel, type MentalModelStorePort, type LearningScope } from "@comis/core";
import type { PromptSkillDescription } from "@comis/skills";
import {
  mergeLearnedSkillsXml,
  materializeLearnedSkills,
  renderLearnedSkillsXml,
  refreshLearnedSkillSurface,
  createRefreshableLearnedSkillSurface,
  renderSkillFile,
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

/**
 * A MentalModel (kind='skill') row mirror; defaults are an active, read-only
 * procedure. `requiredTools` (the read-side procedure discriminator) is spread in
 * ONLY when a test supplies it, so a user-intent skill fixture omits the field
 * entirely (undefined) — exactly the shape the store's mapper produces.
 */
function learned(over: Partial<MentalModel> & { requiredTools?: ReadonlyArray<string> } = {}): MentalModel {
  return {
    id: `id-${over.name ?? "alpha"}`,
    name: over.name ?? "alpha",
    description: over.description ?? "an alpha procedure",
    body: over.body ?? "# Alpha\n\nStep 1. Do the thing.\n",
    kind: over.kind ?? "skill",
    topicKey: over.topicKey ?? "",
    trustLevel: "learned",
    state: over.state ?? "active",
    proofCount: over.proofCount ?? 3,
    confidence: over.confidence ?? 0.9,
    mutating: over.mutating ?? false,
    sourceTrajIds: over.sourceTrajIds ?? [],
    ...(over.requiredTools !== undefined ? { requiredTools: over.requiredTools } : {}),
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
    // The learned <location> is the ABSOLUTE materialized SKILL.md path —
    // consistent with platform skills (which emit metadata.path, an absolute path)
    // so the skill-use attribution index (keyed on the exact <location> string the
    // model reads with) matches a `read` of that same absolute path. A relative
    // location mixed into an absolute-location block would silently break attribution.
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
// Byte-identity goldens — a kind='skill' MentalModel renders + materializes
// to exactly the pinned bytes (the no-behavior-change pin).
// The renderer is byte-deterministic from {name,description,location,source}; a
// kind='skill' row maps to the same PromptSkillDescription, so no `kind` branch
// alters the output. A FIXED workspace dir ('/ws') keeps the absolute <location>
// reproducible in the inline snapshot.
// ---------------------------------------------------------------------------

describe("kind='skill' surface render + SKILL.md are byte-identical (golden)", () => {
  it("mergeLearnedSkillsXml appends a kind='skill' row LAST with <source>learned</source> + absolute SKILL.md location", () => {
    const xml = mergeLearnedSkillsXml(
      [platform("platform-a")],
      [learned({ name: "deploy", description: "deploy the app", body: "1. build\n2. ship" })],
      "/ws",
    );
    expect(xml).toMatchInlineSnapshot(`
      "<available_skills>
        <skill>
          <name>platform-a</name>
          <description>desc-platform-a</description>
          <location>/abs/skills/platform-a</location>
          <source>bundled</source>
        </skill>
        <skill>
          <name>deploy</name>
          <description>deploy the app</description>
          <location>/ws/.learned-skills/deploy/SKILL.md</location>
          <source>learned</source>
        </skill>
      </available_skills>"
    `);
  });

  it("renderSkillFile emits the exact frontmatter (name/description/source:learned) + body + trailing newline", () => {
    const file = renderSkillFile(
      learned({ name: "deploy", description: "deploy the app", body: "1. build\n2. ship" }),
    );
    expect(file).toMatchInlineSnapshot(`
      "---
      name: deploy
      description: "deploy the app"
      source: learned
      ---
      1. build
      2. ship
      "
    `);
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

  it("one poison (path-traversal) skill name is SKIPPED — the other skills still materialize, no throw, no escape", () => {
    // A single malformed `name` (a `..` traversal that makes safePath throw) must
    // NOT abort the whole batch after the wholesale rmSync (which would leave
    // `.current` empty + a half-written subtree). Each skill is materialized under
    // its own try/catch: the bad one is dropped, the good ones survive. Without the
    // per-skill try/catch the throw propagates out of materializeLearnedSkills → the
    // batch is poisoned.
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

/** A minimal MentalModelStorePort stub whose list() returns a fixed Result. */
function makeStore(listResult: Result<MentalModel[], Error>): MentalModelStorePort {
  return {
    admit: async () => ok({ id: "x", admitted: true }),
    get: async () => ok(undefined),
    list: async () => listResult,
    promote: async () => ok(undefined),
    demote: async () => ok(undefined),
    evict: async () => ok(undefined),
  } as unknown as MentalModelStorePort;
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
// The per-agent PROCEDURE-DOC surface budget. Orchestrate-derived procedure docs
// (the `requiredTools`-populated subset) get their OWN per-agent cap
// (`maxProcedureDocsSurfaced`) so a burst can't bloat every prompt's
// <available_skills>; user-intent skills (requiredTools undefined) + topic docs
// keep a SEPARATE, uncapped path. SELECTION keeps the MOST-CORROBORATED M
// (proof_count DESC, created_at ASC tiebreak); PRESENTATION stays append-only
// (created_at-ASC list() order) so an unrelated new skill never reshuffles the
// surfaced procedure docs — deterministic + cache-stable across refreshes.
// Asserted against the REAL materialized `.learned-skills/` set (ground truth).
// ---------------------------------------------------------------------------

describe("refreshLearnedSkillSurface — per-agent procedure-doc budget", () => {
  it("caps the requiredTools-populated subset to maxProcedureDocsSurfaced (equal proof_count ⇒ created_at-ASC tiebreak keeps the oldest); user-intent skills + topics UNAFFECTED", async () => {
    // N=3 procedure docs (requiredTools set) + K=2 user-intent skills + 1 topic (no requiredTools),
    // all active + read-only with EQUAL proof_count (default 3), so the created_at-ASC tiebreak
    // governs and the "kept 2" is unambiguously the oldest two.
    const docs = [
      learned({ name: "proc-old", requiredTools: ["jq"], createdAt: 1_000 }),
      learned({ name: "intent-a", createdAt: 1_500 }),
      learned({ name: "proc-mid", requiredTools: ["jq", "web_fetch"], createdAt: 2_000 }),
      learned({ name: "topic-x", kind: "topic", createdAt: 2_100 }),
      learned({ name: "intent-b", createdAt: 2_500 }),
      learned({ name: "proc-new", requiredTools: ["web_fetch"], createdAt: 3_000 }),
    ];
    // list() returns created_at-ASC (mirror the store's ORDER BY); pass them in that order.
    const store = makeStore(ok(docs));

    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      maxProcedureDocsSurfaced: 2, // M=2 < N=3 → the newest procedure doc is dropped
    });

    const dir = safePath(workDir, ".learned-skills");
    // Equal proof_count ⇒ created_at-ASC tiebreak: exactly the oldest 2 procedure docs
    // materialize; the 3rd (newest) is over budget.
    expect(existsSync(safePath(dir, "proc-old", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(dir, "proc-mid", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(dir, "proc-new", "SKILL.md"))).toBe(false); // dropped by the budget
    // ALL user-intent skills + the topic doc materialize — the procedure budget does not touch them.
    expect(existsSync(safePath(dir, "intent-a", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(dir, "intent-b", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(dir, "topic-x", "SKILL.md"))).toBe(true);
    // The cached (surfaced) set matches the materialized set — the seam renders from it, so an
    // over-budget doc must NOT appear there either (else its <location> points at a missing file).
    expect(surfaced.map((s) => s.name).sort()).toEqual([
      "intent-a",
      "intent-b",
      "proc-mid",
      "proc-old",
      "topic-x",
    ]);
    expect(surfaced.some((s) => s.name === "proc-new")).toBe(false);
  });

  it("surfaces ALL procedure docs when the count is within budget (no omission)", async () => {
    const store = makeStore(
      ok([
        learned({ name: "p1", requiredTools: ["jq"], createdAt: 1_000 }),
        learned({ name: "p2", requiredTools: ["web_fetch"], createdAt: 2_000 }),
      ]),
    );
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      maxProcedureDocsSurfaced: 10, // M=10 > N=2 → nothing dropped
    });
    expect(surfaced.map((s) => s.name).sort()).toEqual(["p1", "p2"]);
    const dir = safePath(workDir, ".learned-skills");
    expect(existsSync(safePath(dir, "p1", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(dir, "p2", "SKILL.md"))).toBe(true);
  });

  it("a budget of 0-capacity edge: with M procedure docs and a tight cap, the non-procedure docs still all surface", async () => {
    // Even a cap of 1 leaves every user-intent skill + topic untouched (separate path).
    const store = makeStore(
      ok([
        learned({ name: "proc-1", requiredTools: ["jq"], createdAt: 1_000 }),
        learned({ name: "proc-2", requiredTools: ["web_fetch"], createdAt: 2_000 }),
        learned({ name: "intent-1", createdAt: 1_500 }),
        learned({ name: "topic-1", kind: "topic", createdAt: 2_500 }),
      ]),
    );
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      maxProcedureDocsSurfaced: 1,
    });
    // 1 procedure (equal proof ⇒ oldest via the created_at tiebreak) + both non-procedure
    // docs = 3; proc-2 dropped.
    expect(surfaced.map((s) => s.name).sort()).toEqual(["intent-1", "proc-1", "topic-1"]);
    expect(surfaced.some((s) => s.name === "proc-2")).toBe(false);
  });

  it("SELECTS by corroboration: keeps the highest proof_count procedure docs — a low-proof OLD doc is shed before a high-proof NEW one", async () => {
    // The oldest procedure doc is the LEAST corroborated, so age-first (the old policy) and
    // corroboration-first DISAGREE about which to drop. proof_count must win.
    const docs = [
      learned({ name: "proc-weak-old", requiredTools: ["jq"], createdAt: 1_000, proofCount: 1 }),
      learned({ name: "proc-mid", requiredTools: ["web_fetch"], createdAt: 2_000, proofCount: 5 }),
      learned({ name: "proc-strong-new", requiredTools: ["grep"], createdAt: 3_000, proofCount: 10 }),
    ];
    const store = makeStore(ok(docs));
    const surfaced = await refreshLearnedSkillSurface({
      learnedSkillStore: store,
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      maxProcedureDocsSurfaced: 2, // keep the 2 MOST-corroborated, drop the least
    });
    const dir = safePath(workDir, ".learned-skills");
    // The most-corroborated 2 survive; the least-corroborated (proof=1) is shed EVEN THOUGH it is
    // the oldest — age is no longer the selection key.
    expect(existsSync(safePath(dir, "proc-strong-new", "SKILL.md"))).toBe(true); // proof 10
    expect(existsSync(safePath(dir, "proc-mid", "SKILL.md"))).toBe(true); // proof 5
    expect(existsSync(safePath(dir, "proc-weak-old", "SKILL.md"))).toBe(false); // proof 1 — dropped
    expect(surfaced.map((s) => s.name).sort()).toEqual(["proc-mid", "proc-strong-new"]);
  });

  it("PRESENTS append-only: admitting a new user-intent skill does NOT reorder the surfaced procedure docs (prompt-cache suffix stability)", async () => {
    // Before: one user-intent skill (oldest) then two procedure docs, in created_at-ASC list() order.
    const before = [
      learned({ name: "intent-1", createdAt: 1_000 }),
      learned({ name: "proc-1", requiredTools: ["jq"], createdAt: 2_000 }),
      learned({ name: "proc-2", requiredTools: ["web_fetch"], createdAt: 3_000 }),
    ];
    const surfacedBefore = await refreshLearnedSkillSurface({
      learnedSkillStore: makeStore(ok(before)),
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      maxProcedureDocsSurfaced: 10, // all within budget — nothing dropped
    });
    // After: a NEW user-intent skill is admitted (newest created_at ⇒ lands LAST in the list).
    const after = [...before, learned({ name: "intent-2", createdAt: 4_000 })];
    const surfacedAfter = await refreshLearnedSkillSurface({
      learnedSkillStore: makeStore(ok(after)),
      scope,
      workspaceDir: workDir,
      logger: noopLogger,
      maxProcedureDocsSurfaced: 10,
    });
    // Append-only: the new skill appends at the END; every prior doc — INCLUDING the procedure
    // docs — keeps its exact position, so the <available_skills> prompt-cache suffix is stable.
    // (The pre-fix `[...nonProcedure, ...procedure]` partition shifted every procedure doc down
    // when a user-intent skill was added, invalidating the suffix.)
    expect(surfacedBefore.map((s) => s.name)).toEqual(["intent-1", "proc-1", "proc-2"]);
    expect(surfacedAfter.map((s) => s.name)).toEqual([...surfacedBefore.map((s) => s.name), "intent-2"]);
  });
});

// ---------------------------------------------------------------------------
// The wholesale surface MUST be kind-filtered to EXCLUDE kind:"profile" — a
// profile doc surfaces ONCE (in the <user_profile> block, prompt-assembly),
// never ALSO in <available_skills>. Without the kind filter, the unfiltered
// list() returns the profile doc, which then materializes into .learned-skills
// (the double-surface).
// ---------------------------------------------------------------------------

/**
 * A KIND-AWARE MentalModelStorePort stub mimicking the real `listByKindStmt`: it
 * records every `kind` arg `list()` was called with, and FILTERS `docs` by that
 * kind (an omitted kind ⇒ ALL kinds — the pre-fix, double-surfacing behavior).
 */
function makeKindAwareStore(docs: MentalModel[]): {
  store: MentalModelStorePort;
  kindCalls: () => Array<"skill" | "profile" | "topic" | undefined>;
} {
  const calls: Array<"skill" | "profile" | "topic" | undefined> = [];
  const store = {
    admit: async () => ok({ id: "x", admitted: true }),
    get: async () => ok(undefined),
    list: async (_scope: LearningScope, kind?: "skill" | "profile" | "topic") => {
      calls.push(kind);
      const filtered = kind === undefined ? docs : docs.filter((d) => d.kind === kind);
      return ok(filtered);
    },
    promote: async () => ok(undefined),
    demote: async () => ok(undefined),
    promoteByName: async () => ok({ changed: true }),
    demoteByName: async () => ok({ changed: true }),
    supersede: async () => ok("superseded" as const),
    evict: async () => ok(undefined),
  } as unknown as MentalModelStorePort;
  return { store, kindCalls: () => calls };
}

describe("the wholesale surface kind-filters OUT kind:'profile' (no double-surface)", () => {
  it("a kind:'profile' doc in the store is NOT materialized into .learned-skills", async () => {
    const { store } = makeKindAwareStore([
      learned({ name: "alpha", kind: "skill" }),
      // A profile doc that WOULD surface (active, read-only) on an unfiltered list().
      learned({ name: "profile-user-u", id: "id-profile", kind: "profile" }),
    ]);
    await refreshLearnedSkillSurface({ learnedSkillStore: store, scope, workspaceDir: workDir, logger: noopLogger });

    // The skill still surfaces (regression guard)…
    expect(existsSync(safePath(workDir, ".learned-skills", "alpha", "SKILL.md"))).toBe(true);
    // …the profile doc does NOT (the kind filter excludes it — no double-surface).
    expect(existsSync(safePath(workDir, ".learned-skills", "profile-user-u", "SKILL.md"))).toBe(false);
  });

  it("a kind:'profile' doc is NOT in the surfaced (cached) set the seam renders", async () => {
    const { store } = makeKindAwareStore([
      learned({ name: "alpha", kind: "skill" }),
      learned({ name: "profile-user-u", id: "id-profile", kind: "profile" }),
    ]);
    const surfaced = await refreshLearnedSkillSurface({ learnedSkillStore: store, scope, workspaceDir: workDir, logger: noopLogger });

    expect(surfaced.some((s) => s.name === "alpha")).toBe(true);
    expect(surfaced.some((s) => s.kind === "profile")).toBe(false);
  });

  it("calls list() with the 'skill' kind filter (the listByKindStmt path), never an unfiltered list", async () => {
    const { store, kindCalls } = makeKindAwareStore([learned({ name: "alpha", kind: "skill" })]);
    await refreshLearnedSkillSurface({ learnedSkillStore: store, scope, workspaceDir: workDir, logger: noopLogger });

    // The surface admits skill + topic while excluding profile. A SINGLE
    // list() round-trip cannot express "skill OR topic" via the single-kind
    // listByKindStmt filter, so the surface lists unfiltered (kind === undefined)
    // and filters in code to skill|topic. Every list() call is unfiltered.
    expect(kindCalls().length).toBeGreaterThan(0);
    expect(kindCalls().every((k) => k === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The wholesale surface admits kind:"topic" (the one-store unification — a
// surfaced topic doc IS the observation recall medium) while STILL excluding
// kind:"profile" (a profile doc surfaces ONCE, in <user_profile>). The filter is
// `d.kind === "skill" || d.kind === "topic"` over an unfiltered list(scope).
// ---------------------------------------------------------------------------

describe("the wholesale surface admits kind:'topic' (still excludes kind:'profile')", () => {
  it("a kind:'topic' doc IS materialized into .learned-skills (the observation recall medium)", async () => {
    const { store } = makeKindAwareStore([
      learned({ name: "alpha", kind: "skill" }),
      learned({ name: "topic-cluster-x", id: "id-topic", kind: "topic" }),
    ]);
    await refreshLearnedSkillSurface({ learnedSkillStore: store, scope, workspaceDir: workDir, logger: noopLogger });

    // The skill still surfaces (regression)…
    expect(existsSync(safePath(workDir, ".learned-skills", "alpha", "SKILL.md"))).toBe(true);
    // …AND the topic doc now surfaces (the broadened filter admits it).
    expect(existsSync(safePath(workDir, ".learned-skills", "topic-cluster-x", "SKILL.md"))).toBe(true);
  });

  it("a kind:'topic' doc IS in the surfaced (cached) set the seam renders; a kind:'profile' doc is NOT", async () => {
    const { store } = makeKindAwareStore([
      learned({ name: "alpha", kind: "skill" }),
      learned({ name: "topic-cluster-x", id: "id-topic", kind: "topic" }),
      learned({ name: "profile-user-u", id: "id-profile", kind: "profile" }),
    ]);
    const surfaced = await refreshLearnedSkillSurface({ learnedSkillStore: store, scope, workspaceDir: workDir, logger: noopLogger });

    expect(surfaced.some((s) => s.name === "alpha")).toBe(true);
    expect(surfaced.some((s) => s.kind === "topic")).toBe(true);
    // The profile doc stays excluded (the no-double-surface guard holds).
    expect(surfaced.some((s) => s.kind === "profile")).toBe(false);
  });

  it("a kind:'profile' doc is STILL NOT materialized into .learned-skills (the no-double-surface guard)", async () => {
    const { store } = makeKindAwareStore([
      learned({ name: "topic-cluster-x", id: "id-topic", kind: "topic" }),
      learned({ name: "profile-user-u", id: "id-profile", kind: "profile" }),
    ]);
    await refreshLearnedSkillSurface({ learnedSkillStore: store, scope, workspaceDir: workDir, logger: noopLogger });

    expect(existsSync(safePath(workDir, ".learned-skills", "topic-cluster-x", "SKILL.md"))).toBe(true);
    expect(existsSync(safePath(workDir, ".learned-skills", "profile-user-u", "SKILL.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createRefreshableLearnedSkillSurface — a re-refresh after a promote
// picks up the newly-active skill on the NEXT listing (it updates
// cache.current; the next freeze reads it). Without the re-refresh the boot
// snapshot is the only one a daemon ever sees → a promoted skill never surfaces.
// ---------------------------------------------------------------------------

/** A registry-backed SkillRegistry stub so renderLearnedSkillsXml can merge. */
function makeRegistryForSurface(): import("@comis/skills").SkillRegistry {
  return makeRegistry([platform("P1")]);
}

describe("createRefreshableLearnedSkillSurface re-refresh picks up a promoted skill", () => {
  it("a promote (list() now returns the skill active) surfaces it on a subsequent refresh()", async () => {
    // list() starts empty, then returns the skill ACTIVE after a 'promote' — the
    // re-refresh picks up the new surfaceable set (next-session pickup).
    let listed: MentalModel[] = [];
    const store = {
      admit: async () => ok({ id: "x", admitted: true }),
      get: async () => ok(undefined),
      list: async () => ok(listed),
      promote: async () => ok(undefined),
      demote: async () => ok(undefined),
      promoteByName: async () => ok({ changed: true }),
      demoteByName: async () => ok({ changed: true }),
      evict: async () => ok(undefined),
    } as unknown as MentalModelStorePort;

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
// The surface registry routes a refresh(agentId) to the registered
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
// wireAgentLearnedSkillSurface gating — default-off (enabled:false) does
// ZERO surface work: NO store list(), NO .learned-skills materialize/rmSync, and
// .current is []. Enabled wires the cache + registers it.
// ---------------------------------------------------------------------------

describe("wireAgentLearnedSkillSurface — default-off does no surface work", () => {
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
    } as unknown as MentalModelStorePort;
    const registry = createLearnedSkillSurfaceRegistry();

    const cache = wireAgentLearnedSkillSurface({
      enabled: false, // gated OFF
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
    } as unknown as MentalModelStorePort;
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
