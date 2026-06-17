// SPDX-License-Identifier: Apache-2.0
/**
 * SandboxSkillValidationAdapter — the @comis/skills implementation of the
 * @comis/core {@link SkillValidationPort} (v2.26 Verified Learning, WS2 step 5).
 *
 * This file holds the STATIC half (Phase 201 Plan 05). This task lands:
 *   - per-field `validateMemoryWrite` safety scan over body / each scripts[].content
 *     / description — `staticOk = severity !== "critical"` PER FIELD (a CRITICAL on
 *     ANY field rejects: the memory-poison `injection-trajectory` defense, SKILL-06);
 *   - `params_schema` compiled via TypeBox `Compile` in a try/catch — a malformed
 *     schema becomes a finding, never a throw.
 *
 * Task 2 of this plan extends it with the LOAD-BEARING `mutating` classification
 * (the explicit `mcp__` OR-branch — the `mutating-mcp-auto-admit` defense) and the
 * `applyToolPolicy` effective-tool-set check. The DYNAMIC (sandbox) half lands in
 * Plan 06 (extends this file); here the dynamic fields are stubbed
 * (`dynamicOk:false`, `reproducedEffect:false`, `coverage:"static-only"`,
 * `sandboxProvider:"none"`).
 *
 * The WHOLE adapter lives in @comis/skills because `applyToolPolicy` (and the
 * sandbox provider, Plan 06) are @comis/skills symbols. The synthesis JOB
 * (@comis/agent, Plan 04) and the daemon consume the port TYPE only — the agent
 * cannot import @comis/skills (the closed-graph SEC-01 cut).
 *
 * SECURITY / privacy (SEC-01 §7): findings carry field names + pattern NAMES +
 * tool names (ids) only — NEVER the offending procedure body / script content.
 *
 * @module
 */

// eslint-disable-next-line import/no-unresolved -- typebox/compile is a package subpath (exports map)
import * as TypeCompiler from "typebox/compile";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import { validateMemoryWrite } from "@comis/core";
import type {
  CandidateSkill,
  LearningScope,
  ReplayContext,
  SkillValidationFinding,
  SkillValidationPort,
  SkillValidationResult,
} from "@comis/core";

/** A pino-compatible structural logger (injected — NOT `getLogger`; the daemon passes the real one). */
interface ValidationLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Dependencies for {@link createSandboxSkillValidationAdapter}.
 *
 * `allTools` + `policy` are the runtime inputs the effective-tool-set check needs;
 * the daemon (Plan 07) injects the agent's full tool list + its tool policy. The
 * adapter resolves the effective set via `applyToolPolicy(allTools, policy)`.
 */
export interface SandboxSkillValidationAdapterDeps {
  /** The agent's full available tool list (drives the effective-tool-set check). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
  allTools: AgentTool<any>[];
  /** The agent's tool policy — `applyToolPolicy` resolves the effective set from it. */
  policy: { profile: string; allow: string[]; deny: string[] };
  /** Optional injected structural logger (counts/ids only — never bodies). */
  logger?: ValidationLogger;
}

/**
 * Create the {@link SkillValidationPort} adapter (static half).
 *
 * `validate` runs the per-field safety scan + params_schema compile and returns
 * `ok(SkillValidationResult)` even when the candidate is unsafe (the verdict's
 * booleans + findings carry the rejection). It NEVER throws — a malformed schema
 * or a critical field is surfaced as a finding / `staticOk:false`. (The mutating
 * classification + the tool-policy check land in this plan's Task 2; the dynamic
 * sandbox replay in Plan 06.)
 */
export function createSandboxSkillValidationAdapter(
  deps: SandboxSkillValidationAdapterDeps,
): SkillValidationPort {
  const { logger } = deps;

  return {
    validate(
      skill: CandidateSkill,
      _replay: ReplayContext,
      scope: LearningScope,
    ): Promise<Result<SkillValidationResult, Error>> {
      const findings: SkillValidationFinding[] = [];

      // --- 1. params_schema compile (TypeBox) ----------------------------------
      // A malformed schema → a finding, NEVER a throw. JSON.parse failure (bad
      // string) and Compile failure (non-object / circular) both land here.
      if (skill.paramsSchema !== undefined && skill.paramsSchema.length > 0) {
        try {
          const parsed: unknown = JSON.parse(skill.paramsSchema);
          // TypeBox TSchema IS JSON Schema directly (no serialization layer).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary synthesized schema
          TypeCompiler.Compile(parsed as any);
        } catch {
          findings.push({ field: "params_schema", kind: "static", patterns: ["schema-compile-failed"] });
        }
      }

      // --- 2. per-field validateMemoryWrite safety scan ------------------------
      // LANDMINE (Pitfall 1): validateMemoryWrite returns { severity }, NOT a
      // boolean. Map `staticOk = severity !== "critical"` PER FIELD — a CRITICAL on
      // ANY text field (body / each scripts[].content / description) → REJECT. A
      // `warn` is benign (recorded, never rejected — never coerced to a boolean).
      scanFields(skill, findings);

      const staticOk = findings.length === 0;

      logger?.debug(
        {
          step: "skill_validation_static",
          tenantId: scope.tenantId,
          agentId: scope.agentId,
          staticOk,
          findingCount: findings.length,
          findingKinds: findings.map((f) => f.kind),
        },
        "skill candidate static validation complete",
      );

      // --- 3. result (dynamic fields stubbed — Plan 06 fills them) -------------
      const result: SkillValidationResult = {
        staticOk,
        dynamicOk: false,
        reproducedEffect: false,
        findings,
        sandboxProvider: "none",
        coverage: "static-only",
      };
      return Promise.resolve(ok(result));
    },
  };
}

/**
 * Run EACH text field through `validateMemoryWrite`, pushing a static finding for
 * any field that classifies CRITICAL. The field tuple covers `body`, `description`,
 * and EVERY `scripts[i].content` (so a critical in scripts[1] is caught and tagged
 * `scripts[1]`, not lumped under a single "scripts" field).
 */
function scanFields(skill: CandidateSkill, findings: SkillValidationFinding[]): void {
  const allTextFields: ReadonlyArray<readonly [string, string]> = [
    ["body", skill.body],
    ["description", skill.description],
    ...skill.scripts.map((s, i): readonly [string, string] => [`scripts[${i}]`, s.content]),
  ];
  for (const [field, content] of allTextFields) {
    const r = validateMemoryWrite(content);
    if (r.severity === "critical") {
      findings.push({ field, kind: "static", patterns: r.criticalPatterns });
    }
  }
}
