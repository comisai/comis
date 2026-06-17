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

import { spawn as nodeSpawn } from "node:child_process";
import * as TypeCompiler from "typebox/compile";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import { validateMemoryWrite, systemSetTimeout, systemClearTimeout } from "@comis/core";
import type {
  CandidateSkill,
  LearningScope,
  ReplayContext,
  SkillValidationFinding,
  SkillValidationPort,
  SkillValidationResult,
} from "@comis/core";
import { applyToolPolicy } from "../skills/policy/index.js";
import { detectSandboxProvider } from "../tools/builtin/sandbox/detect-provider.js";
import type { SandboxProvider } from "../tools/builtin/sandbox/types.js";

/**
 * The minimal `spawn` surface the dynamic replay needs (the `node:child_process`
 * `spawn` is assignable). Injected so the fail-closed (darwin / no-bwrap) AND the
 * available (Linux bwrap) branches are exercised deterministically off-Linux —
 * bwrap is Linux-only, so the unit suite on a `darwin` box CANNOT spawn a real jail.
 */
export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd: string | undefined; env: NodeJS.ProcessEnv; detached: boolean; stdio: [string, string, string] },
) => SpawnedChild;

/** The slice of a Node ChildProcess the replay consumes (exit code + stream close). */
export interface SpawnedChild {
  pid: number | undefined;
  stdout: { on(ev: "data", cb: (chunk: Buffer) => void): void; removeAllListeners(ev: "data"): void } | null;
  stderr: { on(ev: "data", cb: (chunk: Buffer) => void): void; removeAllListeners(ev: "data"): void } | null;
  stdin: { write(s: string): void; end(): void } | null;
  on(ev: "close", cb: (code: number | null, signal: string | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(): void;
}

/** A cancelable one-shot timer handle (the `systemSetTimeout` shape — has `.unref()`). */
interface TimeoutHandle {
  unref?(): void;
}

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
  // --- DYNAMIC (sandbox replay) injectables (Plan 06) ------------------------
  /**
   * Detect the OS sandbox provider. Defaults to the real {@link detectSandboxProvider}
   * (returns `undefined` off Linux). INJECTED so the unit suite drives both the
   * fail-closed (no bwrap) and the available (Linux bwrap) branches on this `darwin`
   * box — bwrap cannot run here, so a real jail can never be materialized in tests.
   * Takes no argument — the adapter emits its OWN `sandbox_unavailable` WARN, so the
   * provider's internal detect-logging is not threaded here (it also sidesteps the
   * `DetectLogger`↔`ValidationLogger` shape mismatch).
   */
  detectProvider?: () => SandboxProvider | undefined;
  /** The process spawner. Defaults to `node:child_process` `spawn` (the executor — NOT `buildArgs`). */
  spawnFn?: SpawnFn;
  /** One-shot timer (anti-DoS per-spawn wall-clock). Defaults to {@link systemSetTimeout}. */
  setTimeoutFn?: (cb: () => void, ms: number) => TimeoutHandle;
  /** Cancel a pending {@link setTimeoutFn} handle. Defaults to {@link systemClearTimeout}. */
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
  /** Per-spawn wall-clock budget (ms). Defaults to {@link DEFAULT_SCRIPT_TIMEOUT_MS}. */
  scriptTimeoutMs?: number;
}

/**
 * Per-embedded-script wall-clock budget (anti-DoS, T-201-33). The synthesis loop
 * is already triple-capped (Plan 04) and this runs offline (cron), so a generous
 * but bounded ceiling is correct — a runaway/hanging script is killed at the cap
 * and counts as a clean fail (`dynamicOk:false`), never a hang.
 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;

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
  // Dynamic injectables — default to the real OS-sandbox + Node spawn + system clock.
  const detectProvider: () => SandboxProvider | undefined = deps.detectProvider ?? (() => detectSandboxProvider());
  const spawnFn: SpawnFn = deps.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  const setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => systemSetTimeout(cb, ms));
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => systemClearTimeout(h as never));
  const scriptTimeoutMs = deps.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  return {
    async validate(
      skill: CandidateSkill,
      replay: ReplayContext,
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

      // --- 5. DYNAMIC sandbox replay (the fail-closed bwrap gate) --------------
      // THE MOST DANGEROUS TRAP (§0.1-C6 / Pitfall 4): the exec path normally
      // degrades OPEN (buildSpawnCommand(sandboxConfig=undefined) → bare
      // /bin/bash -c). The validator INVERTS that to fail-CLOSED — mirroring the
      // terminal-driver's JailUnavailableError posture — so an embedded script
      // NEVER runs unsandboxed: a real Linux bwrap jail is required, else the run
      // honestly degrades to coverage:"static-only".
      const dynamic = await runDynamicReplay(skill, replay, scope, {
        detectProvider,
        spawnFn,
        setTimeoutFn,
        clearTimeoutFn,
        scriptTimeoutMs,
        logger,
      });

      const result: SkillValidationResult = {
        staticOk,
        dynamicOk: dynamic.dynamicOk,
        reproducedEffect: dynamic.reproducedEffect,
        findings: [...findings, ...dynamic.findings],
        sandboxProvider: dynamic.sandboxProvider,
        coverage: dynamic.coverage,
      };
      return ok(result);
    },
  };
}

/** The dynamic-half subset of {@link SkillValidationResult} (+ any dynamic findings). */
interface DynamicOutcome {
  dynamicOk: boolean;
  reproducedEffect: boolean;
  sandboxProvider: SkillValidationResult["sandboxProvider"];
  coverage: SkillValidationResult["coverage"];
  findings: SkillValidationFinding[];
}

/** The resolved dynamic-replay dependencies (defaults applied at the factory). */
interface DynamicDeps {
  detectProvider: () => SandboxProvider | undefined;
  spawnFn: SpawnFn;
  setTimeoutFn: (cb: () => void, ms: number) => TimeoutHandle;
  clearTimeoutFn: (handle: TimeoutHandle) => void;
  scriptTimeoutMs: number;
  logger?: ValidationLogger;
}

/**
 * Run the candidate's embedded `scripts[]` in a fail-closed bwrap jail and report
 * the dynamic verdict. Fails CLOSED: no materializable Linux bwrap jail →
 * `coverage:"static-only"`, `dynamicOk:false` (NEVER an unsandboxed exec — the
 * SEC-01 / T-201-31 guarantee). Plan 06 Task 2 fills the spawn+capture branch.
 */
async function runDynamicReplay(
  skill: CandidateSkill,
  _replay: ReplayContext,
  scope: LearningScope,
  deps: DynamicDeps,
): Promise<DynamicOutcome> {
  const { detectProvider, logger } = deps;

  // Fail-closed jail gate — require a REAL Linux bwrap provider (mirror the
  // terminal-driver JailUnavailableError posture, NOT the open exec fallback).
  const provider = detectProvider();
  const jailable = provider !== undefined && provider.name === "bwrap" && provider.available(); // Linux-only

  if (!jailable) {
    // Honest degradation — NOT a failure metric (Defer ≠ Retry). Embedded-script
    // procedures simply do not dynamic-admit here; admission falls to the
    // read-only / noEmbeddedScripts branch (Plan 04).
    logger?.warn(
      {
        step: "skill_validation_dynamic",
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        errorKind: "sandbox_unavailable",
        sandboxProvider: provider?.name ?? "none",
        hint:
          "no bwrap jail (Linux-only) — dynamic validation degraded to static-only; " +
          "embedded-script procedures do not dynamic-admit on this host",
      },
      "skill validation: sandbox unavailable — static-only",
    );
    return {
      dynamicOk: false,
      reproducedEffect: false,
      sandboxProvider: provider?.name === "sandbox-exec" ? "sandbox-exec" : provider?.name === "bwrap" ? "bwrap" : "none",
      coverage: "static-only",
      findings: [],
    };
  }

  // Script-free candidate: nothing to execute. A jail is available but there is
  // no embedded procedure to replay — so NO dynamic coverage was obtained
  // (coverage:"static-only" is honest: `"full"` means the replay actually ran).
  // Admission falls to the noEmbeddedScripts branch (Plan 04).
  if (skill.scripts.length === 0) {
    return { dynamicOk: false, reproducedEffect: false, sandboxProvider: "bwrap", coverage: "static-only", findings: [] };
  }

  // The scripted spawn+capture branch lands in Plan 06 Task 2.
  return { dynamicOk: false, reproducedEffect: false, sandboxProvider: "bwrap", coverage: "static-only", findings: [] };
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
