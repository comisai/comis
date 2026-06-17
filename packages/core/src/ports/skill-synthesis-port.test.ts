// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  SkillSynthesisPort,
  SynthesisInput,
  CandidateSkill,
  SkillValidationPort,
  SkillValidationResult,
  SkillValidationFinding,
  ReplayContext,
  LearnedSkillStorePort,
  LearnedSkill,
  AdmitSkillInput,
  LearningScope,
} from "../index.js";

// Resolve the port-source directory at runtime so the RED state is reproducible
// from THIS test commit alone: `expectTypeOf` type-only assertions are transform-
// only under vitest (esbuild strips types, never typechecks) and type imports of
// missing symbols do not throw — a pure-type test would pass GREEN on pre-patch
// HEAD. The filesystem guards below DO fail on pre-patch HEAD (the three port
// files do not exist) and the source-grep guards encode the plan's acceptance
// criteria (the type-only import discipline + the SkillValidationResult shape).
const PORTS_DIR = dirname(fileURLToPath(import.meta.url));
const synthesisSrc = join(PORTS_DIR, "skill-synthesis-port.ts");
const validationSrc = join(PORTS_DIR, "skill-validation-port.ts");
const storeSrc = join(PORTS_DIR, "learned-skill-store.ts");
const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

describe("the three NEW port source files exist and honor the closed-graph import discipline", () => {
  it("all three port files are present (interface-first Wave 1)", () => {
    expect(existsSync(synthesisSrc), "skill-synthesis-port.ts must exist").toBe(true);
    expect(existsSync(validationSrc), "skill-validation-port.ts must exist").toBe(true);
    expect(existsSync(storeSrc), "learned-skill-store.ts must exist").toBe(true);
  });

  it("NONE import @comis/memory or @comis/skills (the agent↛memory/skills build cut — SEC-01)", () => {
    for (const [name, src] of [
      ["skill-synthesis-port.ts", read(synthesisSrc)],
      ["skill-validation-port.ts", read(validationSrc)],
      ["learned-skill-store.ts", read(storeSrc)],
    ] as const) {
      expect(src, `${name} must not import @comis/memory`).not.toMatch(/@comis\/memory/);
      expect(src, `${name} must not import @comis/skills`).not.toMatch(/@comis\/skills/);
    }
  });

  it("are type-only — no zod value import in any port file", () => {
    for (const [name, src] of [
      ["skill-synthesis-port.ts", read(synthesisSrc)],
      ["skill-validation-port.ts", read(validationSrc)],
      ["learned-skill-store.ts", read(storeSrc)],
    ] as const) {
      expect(src, `${name} must be type-only (no zod)`).not.toMatch(/from ["']zod["']/);
    }
  });

  it("REUSE LearningScope (import it) — never redefine the isolation DTO", () => {
    expect(read(synthesisSrc)).toMatch(/LearningScope/);
    // The redefinition guard: no `interface LearningScope` / `type LearningScope =`
    // in any of the three files (it is imported from outcome-signal-port).
    for (const src of [read(synthesisSrc), read(validationSrc), read(storeSrc)]) {
      expect(src).not.toMatch(/(?:interface|type)\s+LearningScope\b/);
    }
  });

  it("skill-validation-port.ts pins SkillValidationResult + the closed coverage union", () => {
    const src = read(validationSrc);
    expect(src).toMatch(/SkillValidationResult/);
    expect(src).toMatch(/"full"\s*\|\s*"static-only"/);
  });

  it("learned-skill-store.ts pins the trust literal 'learned' (the DB-CHECK type mirror — SEC-01)", () => {
    expect(read(storeSrc)).toMatch(/LearnedSkillStorePort/);
    expect(read(storeSrc)).toMatch(/"learned"/);
  });
});

/**
 * Phase 201 Plan 01 — the three NEW @comis/core procedural-learning ports
 * (SkillSynthesisPort, SkillValidationPort, LearnedSkillStorePort) + their DTOs.
 *
 * This is the interface-first contract test (the 198 OutcomeSignalPort precedent).
 * It pins:
 *  - the three ports + their DTOs are importable AS TYPES from the @comis/core barrel,
 *  - LearningScope is REUSED (not redefined) — the same isolation DTO threads every method,
 *  - SkillValidationResult has the verbatim design §WS2 shape
 *    (staticOk/dynamicOk/reproducedEffect:boolean, the closed coverage union, sandboxProvider),
 *  - every port method returns a `Result<T, Error>` (no skill-specific error type),
 *  - LearnedSkill.trustLevel is the literal `"learned"` (the type mirror of the DB CHECK — SEC-01).
 */
describe("SkillSynthesisPort — type-only @comis/core contract (interface-first)", () => {
  it("exposes synthesize(input): Promise<Result<CandidateSkill[], Error>>", () => {
    expectTypeOf<SkillSynthesisPort["synthesize"]>().parameters.toEqualTypeOf<[SynthesisInput]>();
    expectTypeOf<
      Awaited<ReturnType<SkillSynthesisPort["synthesize"]>>
    >().toMatchTypeOf<{ ok: boolean }>();
  });

  it("SynthesisInput carries the UNTRUSTED trajectory text + the (tenant,agent) scope + the cluster ids", () => {
    expectTypeOf<SynthesisInput["trajectoryText"]>().toEqualTypeOf<string>();
    expectTypeOf<SynthesisInput["scope"]>().toEqualTypeOf<LearningScope>();
    expectTypeOf<SynthesisInput["clusterTrajIds"]>().toEqualTypeOf<ReadonlyArray<string>>();
  });

  it("CandidateSkill is a markdown body + optional embedded scripts + required tools", () => {
    expectTypeOf<CandidateSkill["name"]>().toEqualTypeOf<string>();
    expectTypeOf<CandidateSkill["body"]>().toEqualTypeOf<string>();
    expectTypeOf<CandidateSkill["scripts"]>().toEqualTypeOf<
      ReadonlyArray<{ path: string; lang: string; content: string }>
    >();
    expectTypeOf<CandidateSkill["requiredTools"]>().toEqualTypeOf<ReadonlyArray<string>>();
  });
});

describe("SkillValidationPort — type-only @comis/core contract", () => {
  it("exposes validate(skill, replay, scope): Promise<Result<SkillValidationResult, Error>>", () => {
    expectTypeOf<SkillValidationPort["validate"]>().parameters.toEqualTypeOf<
      [CandidateSkill, ReplayContext, LearningScope]
    >();
  });

  it("SkillValidationResult is the verbatim design §WS2 shape (booleans + the closed coverage union)", () => {
    expectTypeOf<SkillValidationResult["staticOk"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SkillValidationResult["dynamicOk"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SkillValidationResult["reproducedEffect"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SkillValidationResult["coverage"]>().toEqualTypeOf<"full" | "static-only">();
    expectTypeOf<SkillValidationResult["sandboxProvider"]>().toEqualTypeOf<
      "bwrap" | "sandbox-exec" | "none"
    >();
    expectTypeOf<SkillValidationResult["findings"]>().toEqualTypeOf<SkillValidationFinding[]>();
  });

  it("SkillValidationFinding tags the field + a closed kind union", () => {
    expectTypeOf<SkillValidationFinding["field"]>().toEqualTypeOf<string>();
    expectTypeOf<SkillValidationFinding["kind"]>().toEqualTypeOf<
      "static" | "tool-policy" | "dynamic"
    >();
  });
});

describe("LearnedSkillStorePort — type-only @comis/core contract", () => {
  it("exposes the admit/get/list/promote/demote/evict triad, each threading LearningScope", () => {
    expectTypeOf<LearnedSkillStorePort["admit"]>().parameters.toEqualTypeOf<
      [AdmitSkillInput, LearningScope]
    >();
    expectTypeOf<LearnedSkillStorePort["get"]>().parameters.toEqualTypeOf<[string, LearningScope]>();
    expectTypeOf<LearnedSkillStorePort["list"]>().parameters.toEqualTypeOf<[LearningScope]>();
    expectTypeOf<LearnedSkillStorePort["promote"]>().parameters.toEqualTypeOf<
      [string, LearningScope]
    >();
    expectTypeOf<LearnedSkillStorePort["demote"]>().parameters.toEqualTypeOf<
      [string, LearningScope]
    >();
    expectTypeOf<LearnedSkillStorePort["evict"]>().parameters.toEqualTypeOf<
      [string, LearningScope]
    >();
  });

  it("LearnedSkill.trustLevel is the literal 'learned' (never widened to string — SEC-01)", () => {
    expectTypeOf<LearnedSkill["trustLevel"]>().toEqualTypeOf<"learned">();
    expectTypeOf<LearnedSkill["state"]>().toEqualTypeOf<
      "candidate" | "active" | "stale" | "archived"
    >();
    expectTypeOf<LearnedSkill["proofCount"]>().toEqualTypeOf<number>();
    expectTypeOf<LearnedSkill["mutating"]>().toEqualTypeOf<boolean>();
  });

  it("admit returns Result<{ id; admitted }, Error>", () => {
    expectTypeOf<Awaited<ReturnType<LearnedSkillStorePort["admit"]>>>().toMatchTypeOf<{
      ok: boolean;
    }>();
  });
});
