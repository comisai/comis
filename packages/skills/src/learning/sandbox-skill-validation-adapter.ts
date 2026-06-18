// SPDX-License-Identifier: Apache-2.0
/**
 * SandboxSkillValidationAdapter — the @comis/skills implementation of the
 * @comis/core {@link SkillValidationPort} (v2.26 Verified Learning, WS2 step 5).
 *
 * This file holds the STATIC half (Phase 201 Plan 05):
 *   - per-field `validateMemoryWrite` safety scan over name / body / description /
 *     stringified paramsSchema / each scripts[].content — `staticOk =
 *     severity !== "critical"` PER FIELD (a CRITICAL on ANY field rejects: the
 *     memory-poison `injection-trajectory` defense, SKILL-06); plus a length bound
 *     on the attacker-influenced primary-key `name` (WR-05);
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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { SandboxProvider, ExecSandboxConfig } from "../tools/builtin/sandbox/types.js";
import { buildSpawnCommand } from "../tools/builtin/exec-tool/exec-shared.js";

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
 * The maximum byte/char length allowed for a synthesized `name` (WR-05). `name`
 * is attacker-influenced (LLM output distilled from an UNTRUSTED trajectory),
 * becomes the `learned_skills.name` PRIMARY-KEY input + the `UNIQUE` lookup key,
 * is embedded in the approval `action` string and prompts, and is the one
 * untrusted text field that — pre-fix — had neither a poison scan nor a length
 * bound. A sane cap rejects a megabyte-name DoS at validation. 120 chars matches
 * the prompt's "short, stable, kebab-case" instruction (the schema enforces the
 * charset; this enforces the ceiling regardless of how the candidate arrived).
 */
export const MAX_SKILL_NAME_LENGTH = 120;

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
      // degrades OPEN — an absent (undefined) sandboxConfig makes buildSpawnCommand
      // return a bare `/bin/bash -c`. The validator INVERTS that to fail-CLOSED —
      // mirroring the terminal-driver's JailUnavailableError posture — so an
      // embedded script NEVER runs unsandboxed: a real Linux bwrap jail is
      // required, else the run honestly degrades to coverage:"static-only".
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
        errorKind: "sandbox_unavailable" as const,
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

  // --- The scripted spawn+capture branch (§0.1-C6) ------------------------
  // Materialize each script into a jail workspace, then execute it via
  // buildSpawnCommand → spawn → capture — the EXECUTOR. The sandbox is applied
  // INSIDE buildSpawnCommand (it calls sandboxConfig.sandbox.buildArgs itself);
  // we pass a REAL bwrap ExecSandboxConfig (NEVER undefined → never the open
  // /bin/bash -c fallback). A non-zero exit / spawn-error (e.g. a sandbox-escape
  // attempt the jail denies) → that script fails → dynamicOk:false.
  const jailWorkspace = mkdtempSync(join(tmpdir(), "comis-skill-validate-"));
  try {
    const sandboxConfig = buildValidationSandboxConfig(provider as SandboxProvider);
    const findings: SkillValidationFinding[] = [];
    let allOk = true;

    for (let i = 0; i < skill.scripts.length; i++) {
      const script = skill.scripts[i];

      // IN-04 (defense-in-depth): allowlist the script lang/runner. An
      // unrecognized lang used to silently fall through to the `bash` runner
      // (runnerFor default) — so an attacker-chosen lang ran an arbitrary
      // interpreter (still jailed, but undeclared). Reject an unknown lang as a
      // dynamic finding and DO NOT run it (no materialize, no spawn): the
      // candidate fails dynamicOk instead of executing under a defaulted runner.
      if (!isAllowedScriptLang(script.lang)) {
        allOk = false;
        // counts/ids only — the lang token is a closed-enum signal, never content.
        findings.push({ field: `scripts[${i}]`, kind: "dynamic", patterns: ["unknown-lang"] });
        continue;
      }

      // Write the script into the jail workspace (bounded, jail-only).
      const scriptPath = join(jailWorkspace, `skill-script-${i}.${scriptExt(script.lang)}`);
      writeFileSync(scriptPath, script.content, { mode: 0o600 });
      const scriptCmd = runnerFor(script.lang, scriptPath);

      const exitCode = await spawnAndCapture(scriptCmd, jailWorkspace, sandboxConfig, deps);
      if (exitCode !== 0) {
        allOk = false;
        // counts/ids only — never the script content (SEC-01 §7).
        findings.push({ field: `scripts[${i}]`, kind: "dynamic", patterns: [`exit-${exitCode}`] });
      }
    }

    // reproducedEffect: only assert reproduction where an observable effect is
    // checkable against the trajectory's captured inputs. With no checkable
    // effect (the §14-D2 read-only / non-deterministic classes), it stays false —
    // the admission gate then requires the candidate to be read-only (Plan 04).
    //
    // WR-03: the synthesis job (the only caller) passes an EMPTY ReplayContext
    // today, so `hasCheckableEffect` is false and `reproducedEffect` is
    // structurally false ⇒ no mutating candidate admits (fail-closed-safe). This
    // is a LABELED FORWARD SEAM deferred to 202+ (a real effect-capture-and-
    // compare harness), NOT a broken path: when a non-empty `capturedInputs` IS
    // threaded, this becomes true (pinned in the WR-03 deferral tests). See
    // deferred-items.md.
    const reproducedEffect = allOk && hasCheckableEffect(_replay);

    logger?.debug(
      {
        step: "skill_validation_dynamic",
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        scriptCount: skill.scripts.length,
        dynamicOk: allOk,
        reproducedEffect,
        sandboxProvider: "bwrap",
      },
      "skill candidate dynamic validation complete",
    );

    return { dynamicOk: allOk, reproducedEffect, sandboxProvider: "bwrap", coverage: "full", findings };
  } finally {
    // Always tear down the jail workspace (bounded, no leak).
    rmSync(jailWorkspace, { recursive: true, force: true });
  }
}

/**
 * Build a REAL bwrap {@link ExecSandboxConfig} for the validation jail: the jail
 * workspace is the only RW path, network is `none` (kernel-enforced deny-all
 * egress — a script cannot exfiltrate during validation, T-201-35), and no
 * credential home is exposed. NEVER `undefined` (that is the open `/bin/bash -c`
 * fallback — the exact thing SEC-01 forbids).
 */
function buildValidationSandboxConfig(provider: SandboxProvider): ExecSandboxConfig {
  // The jail workspace itself is passed to buildSpawnCommand as `workspacePath`
  // (the only RW path) — NOT a sharedPaths bind here; this config carries the
  // isolation posture (deny-all egress + no credential home).
  return {
    sandbox: provider,
    sharedPaths: [], // no extra RW binds beyond the jail workspace
    readOnlyPaths: [], // captured-inputs RO binds added when a ReplayContext.workspacePath is wired
    configReadOnlyPaths: [],
    network: { mode: "none" }, // deny-all egress (the validation jail is offline) — T-201-35
    secureCredentialHome: true, // do not RW-expose ~/.local/share credential material
  };
}

/**
 * Spawn one materialized script in the jail via the VERIFIED exec spawn+capture
 * path and resolve its exit code. A per-spawn wall-clock timeout (anti-DoS,
 * T-201-33) kills a runaway/hanging script and resolves a non-zero (124) code.
 * Capture is exit-code only here — stdout/stderr are drained but never logged
 * (SEC-01 §7: never the script content / full output in a log line).
 */
function spawnAndCapture(
  scriptCmd: string,
  jailCwd: string,
  sandboxConfig: ExecSandboxConfig,
  deps: DynamicDeps,
): Promise<number> {
  const { spawnFn, setTimeoutFn, clearTimeoutFn, scriptTimeoutMs } = deps;
  return new Promise<number>((resolve) => {
    // buildSpawnCommand applies the sandbox INSIDE (it calls sandbox.buildArgs);
    // passing a REAL bwrap config returns { bin: "<bwrap>", args: [...jail, "/bin/bash", "-c", cmd] }.
    const { bin, args, cwd } = buildSpawnCommand(scriptCmd, jailCwd, sandboxConfig, jailCwd, jailCwd);
    const child = spawnFn(bin, args, {
      cwd,
      // Hermetic minimal env — never forward the daemon's process.env into the jail
      // (no secrets, no host PATH leakage); bwrap also strips the netns (network:none).
      env: { PATH: "/usr/bin:/bin" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    // A mutable holder so the (possibly synchronous, in tests) timer callback can
    // clear the timer without a temporal-dead-zone reference to its own binding.
    const timerRef: { handle: TimeoutHandle | undefined } = { handle: undefined };
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timerRef.handle !== undefined) clearTimeoutFn(timerRef.handle);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      resolve(code);
    };

    // Drain streams (bounded) so the pipe does not back-pressure; never log the bytes.
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.stdin?.end();

    // Anti-DoS wall-clock timeout — kill a hanging script, resolve 124 (timeout).
    timerRef.handle = setTimeoutFn(() => {
      if (settled) return;
      child.kill();
      settle(124);
    }, scriptTimeoutMs);

    child.on("error", () => settle(127)); // jail refused to spawn → treat as denied
    child.on("close", (code) => settle(code ?? 1));
  });
}

/**
 * The closed allowlist of embedded-script langs the validation jail will run
 * (lowercased), IN-04. Every entry maps to an explicit in-jail runner in
 * {@link runnerFor} (sh/bash → bash, python/py → python3, node/javascript/js →
 * node). A lang OUTSIDE this set is rejected as an `unknown-lang` dynamic finding
 * — it is NEVER materialized or spawned under the `bash` default (which used to
 * run an arbitrary attacker-chosen lang under a silently-defaulted interpreter).
 */
export const ALLOWED_SCRIPT_LANGS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "python",
  "py",
  "node",
  "javascript",
  "js",
]);

/** Whether `lang` is in the {@link ALLOWED_SCRIPT_LANGS} runner allowlist (case-insensitive). */
function isAllowedScriptLang(lang: string): boolean {
  return ALLOWED_SCRIPT_LANGS.has(lang.toLowerCase());
}

/**
 * The file extension for a materialized script of the given lang. Only ever
 * called on an allowlisted lang (the loop rejects unknowns first), so the final
 * `sh` is the sh/bash case — not an unknown-lang fallback.
 */
function scriptExt(lang: string): string {
  const l = lang.toLowerCase();
  if (l === "python" || l === "py") return "py";
  if (l === "node" || l === "javascript" || l === "js") return "js";
  return "sh";
}

/**
 * The in-jail runner command for a materialized script of the given lang. Only
 * ever called on an allowlisted lang (the loop rejects unknowns first), so the
 * final `bash` is the sh/bash case — not an unknown-lang fallback to an arbitrary
 * runner.
 */
function runnerFor(lang: string, scriptPath: string): string {
  const l = lang.toLowerCase();
  if (l === "python" || l === "py") return `python3 ${scriptPath}`;
  if (l === "node" || l === "javascript" || l === "js") return `node ${scriptPath}`;
  return `bash ${scriptPath}`;
}

/**
 * Whether the replay has a checkable observable effect to assert reproduction
 * against. Conservative: only `true` when captured inputs are present (an effect
 * the run can compare). Absent captured inputs (read-only / non-deterministic
 * §14-D2 classes) → `false`, so admission requires the candidate be read-only.
 */
function hasCheckableEffect(replay: ReplayContext): boolean {
  return replay.capturedInputs !== undefined && Object.keys(replay.capturedInputs).length > 0;
}

/**
 * Run EACH untrusted text field through `validateMemoryWrite`, pushing a static
 * finding for any field that classifies CRITICAL. The field tuple covers `name`,
 * `body`, `description`, the stringified `paramsSchema`, and EVERY
 * `scripts[i].content` (so a critical in scripts[1] is caught and tagged
 * `scripts[1]`, not lumped under a single "scripts" field).
 *
 * `name` (WR-05) and `paramsSchema` (IN-02) are attacker-influenced LLM output
 * (distilled from an UNTRUSTED trajectory) that persist to `learned_skills` and,
 * for `name`, flow into the PRIMARY KEY / prompts / approval action — so they MUST
 * be poison-scanned like every other text field. `name` is ALSO length-bounded
 * (a {@link MAX_SKILL_NAME_LENGTH} ceiling) to reject a megabyte-name DoS before
 * the scan runs over it.
 */
function scanFields(skill: CandidateSkill, findings: SkillValidationFinding[]): void {
  // Length bound on the PRIMARY-KEY-input `name` (WR-05). An over-cap name is a
  // static finding (→ staticOk:false) — never silently truncated, so a poisoned
  // oversized name can never enter the store.
  if (skill.name.length > MAX_SKILL_NAME_LENGTH) {
    findings.push({ field: "name", kind: "static", patterns: ["name-too-long"] });
  }
  const allTextFields: ReadonlyArray<readonly [string, string]> = [
    ["name", skill.name],
    ["body", skill.body],
    ["description", skill.description],
    // The stringified params schema is untrusted persisted text — scan it too
    // (it compiles cleanly via TypeBox but the raw string can still smuggle a
    // critical pattern, IN-02). Empty/absent → "" (validateMemoryWrite is clean).
    ["params_schema", skill.paramsSchema ?? ""],
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
