// SPDX-License-Identifier: Apache-2.0
/**
 * `wake-gate-runner` — the exception-safe, fail-open pre-payload gate runner.
 *
 * A scheduled job may carry a gate: a small, model-authored (untrusted) script
 * that runs BEFORE the payload and decides whether to invoke the model at all.
 * {@link createWakeGateRunner} runs that gate in the SAME cap-socket bwrap jail
 * the `orchestrate` tool uses and resolves the outcome through the pure verdict
 * parser.
 *
 * Two invariants are load-bearing:
 *   - FAIL-OPEN. A gate that errors, times out, over-caps, emits no verdict, or
 *     whose per-fire lease mint faults WAKES the model. The shared jailed runner
 *     REJECTS on a SIGKILL-timeout / 4 MiB stdout-overflow / non-zero exit /
 *     spawn error / unavailable jail, and the mint can throw on a LeaseManager /
 *     OutputGuard invariant; the WHOLE body runs inside one try and every one of
 *     those is caught and mapped to `{ wake: true }`. This runner NEVER throws to
 *     the scheduler — a broken gate can never silently drop a monitored job
 *     (which would fail CLOSED: status:error → backoff → auto-suspend).
 *   - LEAST-PRIVILEGE, per fire. Each fire mints a FRESH attenuated lease under a
 *     distinct `root-wakegate-<jobId>-<ts>` root, registers the bearer with the
 *     OutputGuard so it is never logged, and threads it into the jail env as
 *     `COMIS_CAP_LEASE` (+ `COMIS_ORCH_SOCKET`). The gate's tool reach is bounded
 *     by the agent's RESOLVED autonomy capabilities enforced at the cap socket —
 *     not the job's delivery/tool policy.
 *
 * When the host cannot isolate (the namespace preflight failed) or the agent's
 * autonomy is disabled, the runner honestly degrades: it returns a run-as-today
 * signal — no lease, no jailed run — and the caller runs the job unchanged.
 *
 * @module
 */
import {
  resolveAutonomy,
  degradeAutonomy,
  systemNowMs,
  type ComisLogger,
  type ErrorKind,
  type OutputGuardPort,
  type PerAgentConfig,
} from "@comis/core";
import { parseWakeGateVerdict, type WakeGateVerdict } from "@comis/scheduler";
import {
  runJailedScript,
  createResultRefStore,
  type JailedScriptRunnerDeps,
  type JailedScriptResultStore,
  type SandboxProvider,
} from "@comis/skills/tools";
import type { LeaseManager } from "@comis/infra";

import { buildBrokerSpawnEnv, type CapabilityMintDeps } from "./setup-broker-activation.js";

/** Per-fire context the scheduler hook passes when running a gate. */
export interface WakeGateRunContext {
  readonly agentId: string;
  readonly jobId: string;
  /** The formatted main-session key for the job's agent (the lease's session). */
  readonly sessionKey: string;
}

/** The late-bound runner the scheduler holds a ref to. */
export interface WakeGateRunner {
  /**
   * Run the gate. NEVER throws. Returns a wake decision, OR a run-as-today
   * signal when the host cannot jail / autonomy is disabled.
   */
  runWakeGate(
    gate: { script: string; language: "js" | "ts"; timeoutSeconds: number },
    ctx: WakeGateRunContext,
  ): Promise<WakeGateVerdict | { runAsToday: true }>;
}

/** Injected collaborators for {@link createWakeGateRunner} (AGENTS §2.4). */
export interface WakeGateRunnerDeps {
  /** Structured logger — the fail-open WARN + the degrade DEBUG ride it. */
  readonly logger: ComisLogger;
  /** From the cap-layer handle — mints the per-fire lease. */
  readonly leaseManager: LeaseManager;
  /** The daemon OutputGuard — the bearer is registered here at mint (never logged). */
  readonly outputGuard: OutputGuardPort;
  /** The cap socket path threaded into the jail as `COMIS_ORCH_SOCKET`. */
  readonly capSocketPath: string;
  /** `boundedAutonomy.registerRoot` — anchors the per-fire root at mint. */
  readonly registerRoot: (rootRunId: string, leaseId: string, parentLeaseId?: string) => void;
  /** The OS sandbox provider (bwrap on Linux) — the jail arg generator. */
  readonly sandbox: SandboxProvider;
  /** Per-agent jailed-workspace resolver (the writable jail root). */
  readonly resolveWorkspace: (agentId: string) => string;
  /** The agents config map — `resolveAutonomy(agents[agentId]?.autonomy)`. */
  readonly agents: Record<string, PerAgentConfig>;
  /** The credential-free inherited env the jailed core scrubs (daemon exec env). */
  readonly baseEnv: Record<string, string | undefined>;
  /** The boot namespace-preflight boolean — false ⇒ honest degrade (no jail). */
  readonly namespacePreflightOk: boolean;
  /** Injected wall clock (default {@link systemNowMs}) — the `-<ts>` root suffix. */
  readonly now?: () => number;
  /**
   * The jailed-run seam (default the real {@link runJailedScript}) — injected so
   * the exception-safety + bearer tests run WITHOUT a real bwrap jail.
   */
  readonly runJailedScriptFn?: (
    deps: JailedScriptRunnerDeps,
    params: { script: string; language: "js" | "ts"; timeoutMs?: number },
  ) => Promise<string>;
  /** The ResultRef store (default `createResultRefStore({ logger })`). */
  readonly store?: JailedScriptResultStore;
}

/**
 * Classify a fail-open cause into the closed {@link ErrorKind} union so the WARN
 * an operator filters on ("why does this gate always wake?") names the real
 * fault, not a blanket `"timeout"`. A SIGKILL-timeout is `"timeout"`; a stdout
 * size-cap overflow is `"resource"`; everything else — the gate script's
 * non-zero exit, a spawn error, an unavailable jail, or a lease-broker mint
 * fault — is a `"dependency"` failure (the gate is an external untrusted script
 * and the jail/broker is an external dependency). The precise `err` still rides
 * the WARN payload, so the exact cause stays visible.
 */
function classifyWakeGateFailure(err: unknown): ErrorKind {
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(message)) return "timeout";
  if (/hard cap/i.test(message)) return "resource";
  return "dependency";
}

/**
 * Build the wake-gate runner. `runWakeGate` is total: it resolves to a verdict on
 * a clean run, to `{ wake: true }` on ANY jailed-run failure (fail-open), or to
 * `{ runAsToday: true }` when the host cannot jail / autonomy is disabled — it
 * never rejects.
 */
export function createWakeGateRunner(deps: WakeGateRunnerDeps): WakeGateRunner {
  const log = deps.logger.child({ submodule: "wake-gate-runner" });

  return {
    async runWakeGate(gate, ctx) {
      // The WHOLE body is fail-open: the degrade, the per-fire lease mint, the
      // deps assembly, and the jailed run all sit inside ONE try. Any throw —
      // including a mintLease / registerSecret / registerRoot fault — maps to a
      // wake, never a rethrow, so a broken gate can never fail CLOSED (a
      // status:error would trigger scheduler backoff → auto-suspend). The
      // `runAsToday` degrade is a normal return from inside the try (not a throw),
      // so the catch is skipped for it.
      try {
        // 1. Honest degrade. Resolve the agent's autonomy through the SAME
        //    preflight-driven downshift the tool wiring uses; a disabled posture
        //    (assistant, or a host that cannot build the jail) runs the job as
        //    today — no lease, no jailed run, never a silent unjailed run.
        const resolved = degradeAutonomy(resolveAutonomy(deps.agents[ctx.agentId]?.autonomy), {
          namespacePreflightOk: deps.namespacePreflightOk,
        }).resolved;
        if (!resolved.enabled) {
          log.debug(
            { agentId: ctx.agentId, jobId: ctx.jobId, step: "degrade" },
            "wake-gate skipped (autonomy disabled or sandbox unavailable) — running the job as today",
          );
          return { runAsToday: true };
        }

        // 2. Mint the per-fire lease WITH the bearer threaded. Reuse the shipped
        //    mint (mintLease → registerSecret(bearer) → registerRoot →
        //    COMIS_CAP_LEASE/COMIS_ORCH_SOCKET). Caps are the agent's RESOLVED
        //    autonomy caps enforced at the cap socket — never a job tool policy.
        //    A fault here is caught below and fails OPEN (waking), never closed.
        const ts = (deps.now ?? systemNowMs)().toString(36);
        const rootRunId = `root-wakegate-${ctx.jobId}-${ts}`;
        const capMint: CapabilityMintDeps = {
          leaseManager: deps.leaseManager,
          outputGuard: deps.outputGuard,
          capSocketPath: deps.capSocketPath,
          resolvedCaps: resolved.capabilities,
          budgetRef: `run-wakegate-${ctx.jobId}-${ts}`,
          sessionKey: ctx.sessionKey,
          rootRunId,
          registerRoot: deps.registerRoot,
        };
        const spawnEnv = buildBrokerSpawnEnv(undefined, ctx.agentId, capMint);

        // 3. Assemble the per-fire jailed-run deps (the SAME shared jail the
        //    orchestrate tool drives). The lease env rides brokerSpawnEnv.
        const runnerDeps: JailedScriptRunnerDeps = {
          logger: deps.logger,
          workspaceResolver: () => deps.resolveWorkspace(ctx.agentId),
          capSocketPath: deps.capSocketPath,
          sandbox: deps.sandbox,
          brokerSpawnEnv: spawnEnv,
          store: deps.store ?? createResultRefStore({ logger: deps.logger }),
          baseEnv: deps.baseEnv,
          ...(deps.now ? { now: deps.now } : {}),
        };
        const runFn = deps.runJailedScriptFn ?? runJailedScript;

        // 4. Run the gate; fail open on EVERY rejection. The runner rejects on a
        //    SIGKILL-timeout / 4 MiB overflow / non-zero exit / spawn error / an
        //    unavailable jail — each maps to a wake. Never rethrow to the scheduler.
        const stdout = await runFn(runnerDeps, {
          script: gate.script,
          language: gate.language,
          timeoutMs: gate.timeoutSeconds * 1000,
        });
        // A clean resolve means the child exited 0 without timing out/overflowing
        // (those paths REJECT). The parser fails open on empty/unparseable stdout.
        const verdict = parseWakeGateVerdict({ stdout, exitCode: 0, timedOut: false, overflowed: false });

        // 5. Egress-scrub the delivered status HERE, in the gate, before the
        //    verdict leaves. The cron-delivery listener ships `result` VERBATIM on
        //    its raw/system_event branch (no filterResponse, OutputGuard not
        //    applied there), so an untrusted, model-authored `deliver` string is
        //    scrubbed at the gate or a registered secret/canary could reach the
        //    channel. `context` is model-only (wrapped elsewhere) and `wake` is a
        //    boolean — only `deliver` egresses verbatim, so only `deliver` is scanned.
        if (verdict.deliver !== undefined) {
          const scanned = deps.outputGuard.scan(verdict.deliver);
          if (scanned.ok) {
            return { ...verdict, deliver: scanned.value.sanitized };
          }
          // A scrub fault must never egress unscrubbed untrusted text: DROP the
          // deliver, degrading to a plain skip (no delivery). The pure-skip path
          // is always safe. `wake`/`context` are preserved as parsed.
          log.warn(
            {
              err: scanned.error,
              agentId: ctx.agentId,
              jobId: ctx.jobId,
              errorKind: "internal" as const,
              hint: "output-guard scan failed on the gate deliver text — dropping the deliver (skip, no delivery) to avoid unscrubbed egress",
            },
            "Wake-gate deliver scrub failed — dropping deliver",
          );
          return { wake: verdict.wake, ...(verdict.context !== undefined ? { context: verdict.context } : {}) };
        }
        return verdict;
      } catch (err) {
        log.warn(
          {
            err,
            agentId: ctx.agentId,
            jobId: ctx.jobId,
            errorKind: classifyWakeGateFailure(err),
            hint: "wake-gate failed — waking the model (fail-open)",
          },
          "Wake-gate failed — waking (fail-open)",
        );
        return { wake: true };
      }
    },
  };
}
