// SPDX-License-Identifier: Apache-2.0
/**
 * SandboxSkillValidationAdapter — the @comis/skills implementation of the
 * @comis/core {@link SkillValidationPort} (v2.26 Verified Learning, WS2 step 5).
 *
 * This file holds the STATIC half (Phase 201 Plan 05):
 *   - per-field `validateMemoryWrite` safety scan over body / each scripts[].content
 *     / description — `staticOk = severity !== "critical"` PER FIELD (a CRITICAL on
 *     ANY field rejects: the memory-poison `injection-trajectory` defense, SKILL-06);
 *   - `params_schema` compiled via TypeBox `Compile` in a try/catch — a malformed
 *     schema becomes a finding, never a throw;
 *   - `mutating` classification with the LOAD-BEARING `mcp__` OR-branch (the
 *     `mutating-mcp-auto-admit` defense — see {@link classifyMutating}); and
 *   - every required_tool checked against the agent's effective tool set
 *     (`applyToolPolicy`) — an out-of-policy tool is a `tool-policy` finding.
 *
 * The DYNAMIC (sandbox) half lands in Plan 06 (extends this file); here the
 * dynamic fields are stubbed (`dynamicOk:false`, `reproducedEffect:false`,
 * `coverage:"static-only"`, `sandboxProvider:"none"`).
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
import { applyToolPolicy } from "../skills/policy/index.js";

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
 * The small set of unambiguously read-only built-in tools (lowercased). MIRRORS
 * the @comis/agent synthesis-job `READ_ONLY_TOOLS` (skill-synthesis-job.ts:651)
 * so the validator's mutating verdict and the consumer's `candidateMutates` derive
 * the SAME classification from one contract — there is exactly one mutating
 * predicate, replicated (not shared) only because of the agent↛skills closed-graph
 * cut. A registry/metadata lookup is deliberately NOT used: the metadata registry
 * may be unpopulated at offline-synthesis time (a `read` tool would then default to
 * mutating), so a conservative explicit allow-set is the reliable read-only signal.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "search",
  "get",
]);

/**
 * Classify whether a candidate's required tools make the procedure MUTATING.
 *
 * LOAD-BEARING (Pitfall 2): `isReadOnlyTool` (the @comis/agent heuristic) returns
 * `true` for ANY `mcp__`-prefixed tool — MCP servers "manage their own state". So
 * WITHOUT the explicit `t.startsWith("mcp__")` OR-branch a mutating MCP tool (e.g.
 * `mcp__github__create_issue`) would classify read-only and AUTO-ADMIT past the
 * ApprovalGate. The `mcp__` branch forces every MCP required-tool to be treated as
 * mutating (the `mutating-mcp-auto-admit` defense, SEC-01 / T-201-25).
 *
 * The non-MCP arm is conservative: a tool NOT in {@link READ_ONLY_TOOLS} is
 * mutating (unknown tools are mutating for safety). A candidate with NO required
 * tools is read-only. This is byte-for-byte the @comis/agent `candidateMutates`
 * predicate (skill-synthesis-job.ts:642-647).
 */
export function classifyMutating(requiredTools: ReadonlyArray<string>): boolean {
  return requiredTools.some((t) => {
    const lower = t.toLowerCase();
    if (lower.startsWith("mcp__")) return true; // mcp__ tools are conservatively mutating
    return !READ_ONLY_TOOLS.has(lower);
  });
}

/**
 * Create the {@link SkillValidationPort} adapter (static half).
 *
 * `validate` runs the per-field safety scan + params_schema compile + the mutating
 * / tool-policy classification, and returns `ok(SkillValidationResult)` even when
 * the candidate is unsafe (the verdict's booleans + findings carry the rejection).
 * It NEVER throws — a malformed schema, an out-of-policy tool, or a critical field
 * is surfaced as a finding / `staticOk:false`. (The dynamic sandbox replay lands
 * in Plan 06.)
 */
export function createSandboxSkillValidationAdapter(
  deps: SandboxSkillValidationAdapterDeps,
): SkillValidationPort {
  const { allTools, policy, logger } = deps;

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

      // --- 3. mutating classification (the load-bearing mcp__ branch) ----------
      // The mutating verdict drives admission routing (read-only auto-admit /
      // mutating → ApprovalGate). The Plan 04 consumer (`runSkillSynthesis`)
      // derives mutating from `requiredTools` with the IDENTICAL predicate
      // (`candidateMutates` — `mcp__` OR not-read-only), so this is NOT widened
      // onto the SkillValidationResult shape (which has no `mutating` field — the
      // Plan 01 contract). It is computed + logged here as the @comis/skills-side
      // authority (exported for reuse); the security guarantee is that an
      // `mcp__`-prefixed required tool is classified mutating (never auto-admitted).
      const mutating = classifyMutating(skill.requiredTools);

      // --- 4. required_tool ∈ effective tool set (applyToolPolicy) -------------
      checkToolPolicy(skill.requiredTools, allTools, policy, findings);

      const staticOk = findings.length === 0;

      logger?.debug(
        {
          step: "skill_validation_static",
          tenantId: scope.tenantId,
          agentId: scope.agentId,
          staticOk,
          mutating,
          findingCount: findings.length,
          findingKinds: findings.map((f) => f.kind),
        },
        "skill candidate static validation complete",
      );

      // --- 5. result (dynamic fields stubbed — Plan 06 fills them) -------------
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

/**
 * Check every required tool against the agent's effective tool set (the result of
 * `applyToolPolicy(allTools, policy)` — names only). Any required tool NOT in the
 * effective set → a `tool-policy` finding (and `staticOk:false`). This is the
 * out-of-policy-tool defense (T-201-26).
 */
function checkToolPolicy(
  requiredTools: ReadonlyArray<string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
  allTools: AgentTool<any>[],
  policy: { profile: string; allow: string[]; deny: string[] },
  findings: SkillValidationFinding[],
): void {
  const effective = new Set(applyToolPolicy(allTools, policy).tools.map((t) => t.name));
  for (const t of requiredTools) {
    if (!effective.has(t)) {
      findings.push({ field: "required_tools", kind: "tool-policy", tool: t });
    }
  }
}
