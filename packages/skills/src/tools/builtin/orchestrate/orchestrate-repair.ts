// SPDX-License-Identifier: Apache-2.0
// @allow-throw: runScriptWithOneShotRepair re-throws the ORIGINAL bounded run
// error when a repaired re-run still fails or the repair seam gives up — an
// honest-degrade back to the orchestrate runner, whose AgentTool execution
// boundary (agent-loop) catches it and surfaces it as a tool error.
/**
 * `orchestrate-repair` — the jailed-script execution engine for the `orchestrate`
 * runner: drive one jailed child to completion, classify its failure onto a
 * closed enum, and wrap the run in a bounded one-shot auto-repair.
 *
 *   - {@link runJailedChild} — spawn + drive one jailed child: collect a
 *     byte-capped stdout, keep only a bounded stderr TAIL (surfaced ONLY on a
 *     non-zero exit — the success path is stdout-only), kill on timeout or on a
 *     stdout flood, and resolve the raw stdout or reject a classified
 *     {@link OrchestrateRunFailure}. stderr and intermediate output never
 *     re-enter context.
 *   - {@link runScriptWithOneShotRepair} — write the script into the jail then
 *     run it; on a non-zero exit whose bounded stderr tail matches a known-
 *     recoverable class, do ONE utility-model re-prompt (the injected
 *     {@link OrchestrateRepairSeam}) and re-run the regenerated script EXACTLY
 *     once, in the identical jail/cap/lease envelope the caller built. Class-
 *     gated (ON for weaker models, OFF for stronger); bounded to a single
 *     attempt — a repaired-then-failed run surfaces the ORIGINAL bounded error,
 *     never a loop.
 *   - {@link classifyRunError} — map a thrown run error to its closed
 *     {@link OrchestrateFailureClass} + exit code for the run_summary emit.
 *
 * The runner (orchestrate-tool) builds the jail/cap/lease envelope (args +
 * secret-scrubbed env + per-run lease) and delegates execution here; the
 * cap-socket endpoint stays the sole authoritative capability boundary.
 *
 * @module
 */
import { writeFileSync } from "node:fs";

import {
  systemClearTimeout,
  systemSetTimeout,
  type ComisLogger,
  type EventMap,
  type SystemTimeoutHandle,
} from "@comis/core";
import { autoRepairForClass } from "@comis/agent";
import type { CapabilityClass } from "@comis/agent";

import { buildDescribeDigest, classifyRecoverableStderr } from "./orchestrate-preflight.js";
import { withDurableKeepAlive, type OrchestrateDurableRuns } from "./orchestrate-durable.js";

// ---------------------------------------------------------------------------
// The spawned-child seam (injected so the macOS unit suite runs with no real spawn).
// ---------------------------------------------------------------------------

/** The bits of a spawned child the runner consumes (a `child_process` subset). */
export interface OrchestrateSpawnedChild {
  readonly stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** The spawn seam — injected so the macOS unit suite runs WITHOUT a real spawn. */
export type OrchestrateSpawnFn = (
  bin: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
) => OrchestrateSpawnedChild;

/**
 * The daemon-minted one-shot repair completion closure: given the failed script +
 * its bounded stderr tail + a describe digest, it does ONE utility-model re-prompt
 * and returns the regenerated script (or `undefined` on give-up).
 */
export type OrchestrateRepairSeam = (input: {
  script: string;
  language: "ts" | "js" | "py";
  stderrTail: string;
  describeDigest: string;
}) => Promise<string | undefined>;

// ---------------------------------------------------------------------------
// Constants + the failure model.
// ---------------------------------------------------------------------------

/**
 * The hard in-stream ceiling on the daemon-side stdout collector. The post-exit
 * stdout size-bounce only runs AFTER the child exits, so without this an
 * unbounded jailed `console.log` flood would grow the daemon heap for the whole
 * run. 4 MiB leaves ample headroom for a legitimate large result while bounding
 * memory; past it the runner SIGKILLs the child and fails closed. Exported so the
 * bound is unit-testable.
 */
export const STDOUT_HARD_CAP_BYTES = 4 * 1024 * 1024;

/**
 * The wall-clock budget (ms) the runner ADDS to a per-run child lease's TTL when
 * one-shot auto-repair is enabled for the run, so the single lease minted before
 * the initial run stays valid through the repair-completion await and into the
 * repaired re-run's in-jail cap calls. Sized to the repair seam's own hard
 * completion ceiling (the utility-model abort timeout in `orchestrate-repair-seam.ts`,
 * 120s): the seam blocks for at most that long between the two runs, so a lease
 * short by less than this can expire mid-repair and deny the repaired run's cap
 * calls (fails closed, but the repair silently no-ops for exactly the slow/local
 * small models it targets). MUST stay >= that seam ceiling — raising the seam
 * timeout above this reopens the gap. A larger-than-run child lease is harmless:
 * it is still the short-lived, audience-bound, attenuateCaps-bounded per-run child,
 * just sized to the real run+repair window rather than the run alone.
 */
export const REPAIR_LEASE_BUDGET_MS = 120_000;

/**
 * Whether one-shot auto-repair is enabled for a run's capability class — the pure
 * class-gate with the runner's fail-safe default applied (an absent class → the
 * repair-eligible `small`, matching the platform's fail-closed direction). The
 * SINGLE source of the class-gate: the runner consults it to size the child-lease
 * TTL for the repair window (when a seam is also wired), and
 * {@link runScriptWithOneShotRepair} consults it as part of its larger gate (which
 * additionally requires a wired seam AND a recoverable failure) — so the lease
 * sizing and the actual repair decision can never disagree on eligibility.
 */
export function repairEnabledForClass(capabilityClass: CapabilityClass | undefined): boolean {
  return autoRepairForClass(capabilityClass ?? "small");
}

/**
 * Max chars of the jailed child's stderr retained as a diagnostic TAIL. On the
 * success path stderr is dropped (stdout-only — diagnostic noise stays out of
 * context); on a NON-ZERO exit this bounded tail is the only signal of WHY the
 * child died (a thrown `TypeError`, a bad import, a comis_tools misuse) and is
 * surfaced in the rejection so the failure is diagnosable without a re-run.
 * Bounded so a stderr flood can neither
 * grow the daemon heap nor swamp the error/context. The surfaced tail still
 * passes the daemon OutputGuard on egress, and the jail env is secret-scrubbed.
 */
const STDERR_TAIL_MAX_CHARS = 2_000;

/** The closed run-degradation classes on `orchestrate:run_summary.failureClass`. */
export type OrchestrateFailureClass = NonNullable<
  EventMap["orchestrate:run_summary"]["failureClass"]
>;

/** Exit-code sentinels for the kill / spawn-fail paths where the child returns none. */
const EXIT_CODE_TIMEOUT = 124; // GNU `timeout` convention.
const EXIT_CODE_SIGKILL = 137; // 128 + SIGKILL(9) — the stdout hard-cap kill.
const EXIT_CODE_SPAWN_FAIL = 127; // exec/spawn failure convention.

/**
 * A classified orchestrate-run failure: the closed {@link OrchestrateFailureClass}
 * + the process exit code (a sentinel where the child produced none). Each throw
 * site maps to a member BEFORE the run_summary emit, keeping the bus payload on a
 * closed enum; the free-text message stays on the bounded tool-error surface,
 * NEVER on the bus.
 */
class OrchestrateRunFailure extends Error {
  readonly failureClass: OrchestrateFailureClass;
  readonly exitCode: number;
  /**
   * The bounded, already-scrubbed stderr tail captured at the non-zero exit (empty
   * on the timeout / stdout-cap / spawn-throw paths, which carry no child stderr).
   * A STRUCTURED field so the one-shot repair path can classify + feed it directly,
   * never by re-parsing {@link Error.message}.
   */
  readonly stderrTail: string;
  constructor(
    message: string,
    failureClass: OrchestrateFailureClass,
    exitCode: number,
    stderrTail = "",
  ) {
    super(message);
    this.name = "OrchestrateRunFailure";
    this.failureClass = failureClass;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/**
 * Map a thrown run error to its closed failure class + exit code. A carried
 * {@link OrchestrateRunFailure} forwards its own class; any UNCLASSIFIED throw (a
 * synchronous spawn throw, a child `error` event, a jail-unavailable refusal) is
 * a spawn-class failure — the jail could not run.
 */
export function classifyRunError(err: unknown): {
  failureClass: OrchestrateFailureClass;
  exitCode: number;
} {
  if (err instanceof OrchestrateRunFailure) {
    return { failureClass: err.failureClass, exitCode: err.exitCode };
  }
  return { failureClass: "spawn_fail", exitCode: EXIT_CODE_SPAWN_FAIL };
}

// ---------------------------------------------------------------------------
// The single-attempt jailed-child driver.
// ---------------------------------------------------------------------------

/**
 * Drive the jailed child to completion: collect stdout, surface a non-zero exit
 * or a spawn error as a tool error (NEVER a silent success), kill on timeout.
 * stderr is read+discarded (it never re-enters context — stdout-only).
 */
function runJailedChild(
  spawnFn: OrchestrateSpawnFn,
  bin: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
  timeoutMs: number,
  ctx: { runId: string; log: ComisLogger },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: OrchestrateSpawnedChild;
    try {
      child = spawnFn(bin, args, opts);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stderrTail = "";
    let settled = false;
    const timer: SystemTimeoutHandle = systemSetTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(
        new OrchestrateRunFailure(
          `orchestrate run exceeded its ${timeoutMs}ms timeout`,
          "timeout",
          EXIT_CODE_TIMEOUT,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      // Bound the in-stream accumulation. The post-exit stdout size-bounce
      // does not protect the daemon heap DURING the run, so a jailed
      // `while(true) console.log(...)` flood must be stopped here — fail closed:
      // stop appending, SIGKILL the runaway child, and reject.
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_HARD_CAP_BYTES) {
        settled = true;
        systemClearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        ctx.log.warn(
          { runId: ctx.runId, errorKind: "resource" as const, stdoutBytes, hint: `Jailed stdout exceeded the ${STDOUT_HARD_CAP_BYTES}B hard cap — the script was killed. Have it write high-volume output to a ResultRef (materialize) and slice it in-jail instead of console.log-ing it.` },
          "orchestrate jailed child exceeded the stdout hard cap — killed",
        );
        reject(
          new OrchestrateRunFailure(
            `orchestrate stdout exceeded the ${STDOUT_HARD_CAP_BYTES}B hard cap`,
            "stdout_cap",
            EXIT_CODE_SIGKILL,
          ),
        );
        return;
      }
      stdout += chunk.toString("utf8");
    });
    // Read stderr but keep only a BOUNDED TAIL — it cannot back-pressure the child
    // and never re-enters context on the SUCCESS path (stdout-only). But on a
    // NON-ZERO exit the tail is the only signal of WHY the child died, so the close
    // handler surfaces it in the rejection (otherwise the failure is just
    // "exited with code N" and undiagnosable without a re-run).
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX_CHARS);
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      if (code !== 0 && code !== null) {
        const tail = stderrTail.trim();
        ctx.log.warn(
          {
            runId: ctx.runId,
            errorKind: "internal" as const,
            hint: "Inspect stderrTail, correct the jailed script or referenced capability/tool name, then retry the orchestrate call.",
            exitCode: code,
            stderrTail: tail ? tail.slice(-512) : undefined,
          },
          "orchestrate jailed child exited non-zero",
        );
        reject(
          new OrchestrateRunFailure(
            `orchestrate jailed child exited with code ${code}${tail ? `:\n${tail}` : ""}`,
            "nonzero_exit",
            code,
            tail,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// The bounded one-shot repair orchestration.
// ---------------------------------------------------------------------------

/**
 * Run the model's script in the jailed child, with a bounded one-shot auto-repair.
 *
 * Writes the script into the jail workspace then drives the jailed child to
 * completion — stdout ONLY re-enters context; stderr and intermediate output
 * never do. On a non-zero exit whose bounded stderr tail matches a known-
 * recoverable class, it does ONE utility-model re-prompt (the injected
 * {@link OrchestrateRepairSeam}) and re-runs the regenerated script EXACTLY once.
 *
 * Class-gated: repair is ON for weaker models, OFF for stronger; an absent class
 * defaults to the repair-eligible class (fail-safe ON for an unknown small-target
 * deployment). Bounded to a single attempt — a repaired-then-failed run surfaces
 * the ORIGINAL bounded error, never a loop. Both the initial run and the single
 * repaired re-run share the identical jail/cap/lease envelope the caller built
 * (bin / spawnArgs / childEnv / scriptPath), so the regenerated script has the
 * SAME blast radius as the original (no cap widening); the cap-socket endpoint
 * stays the sole authoritative boundary. Returns the FINAL run's raw stdout, or
 * throws the failure the caller maps + emits.
 */
export async function runScriptWithOneShotRepair(input: {
  readonly spawnFn: OrchestrateSpawnFn;
  readonly bin: string;
  readonly spawnArgs: string[];
  readonly childEnv: Record<string, string | undefined>;
  readonly scriptPath: string;
  readonly timeoutMs: number;
  readonly script: string;
  readonly language: "ts" | "js" | "py";
  readonly capabilityClass: CapabilityClass | undefined;
  readonly repairSeam: OrchestrateRepairSeam | undefined;
  readonly log: ComisLogger;
  readonly runId: string;
  /**
   * When wired, bracket the WHOLE run (initial + one-shot repair) with a durable
   * heartbeat keep-alive so a long LIVE child is never mistaken for a crash and
   * reaped by the watchdog's no-progress re-anchor cap. No-op when `runs` is
   * undefined (durability off).
   */
  readonly keepAlive?: { runs: OrchestrateDurableRuns | undefined; checkpointId: string; now: () => number };
}): Promise<string> {
  const {
    spawnFn,
    bin,
    spawnArgs,
    childEnv,
    scriptPath,
    timeoutMs,
    script,
    language,
    capabilityClass,
    repairSeam,
    log,
    runId,
    keepAlive,
  } = input;

  // attemptRun writes the script into the workspace then drives the jailed child
  // to completion. BOTH the initial run and the single repaired re-run go through
  // it, sharing the identical jail/cap/lease envelope built by the caller.
  const attemptRun = async (scriptText: string): Promise<string> => {
    writeFileSync(scriptPath, scriptText);
    return runJailedChild(
      spawnFn,
      bin,
      spawnArgs,
      { env: childEnv, cwd: undefined },
      timeoutMs,
      { runId, log },
    );
  };

  const runWithRepair = async (): Promise<string> => {
  try {
    return await attemptRun(script);
  } catch (runErr) {
    const { failureClass } = classifyRunError(runErr);
    const recoverable =
      runErr instanceof OrchestrateRunFailure
        ? classifyRecoverableStderr(runErr.stderrTail)
        : undefined;
    if (
      failureClass === "nonzero_exit" &&
      repairEnabledForClass(capabilityClass) &&
      repairSeam !== undefined &&
      recoverable !== undefined
    ) {
      log.debug({ runId, step: "repair", recoverable }, "orchestrate one-shot repair attempt");
      const regenerated = await repairSeam({
        script,
        language,
        // Sound: recoverable !== undefined implies runErr is an
        // OrchestrateRunFailure (the ternary above only classifies that case).
        stderrTail: (runErr as OrchestrateRunFailure).stderrTail,
        describeDigest: buildDescribeDigest(),
      });
      if (regenerated !== undefined && regenerated.trim() !== "") {
        // The ONE re-run — no loop. A repaired-then-failed run re-throws the
        // ORIGINAL bounded error (the seam's output did not fix the script).
        try {
          return await attemptRun(regenerated);
        } catch {
          throw runErr;
        }
      }
      // The seam gave up (no regenerated script) — honest-degrade to the
      // original bounded error.
      throw runErr;
    }
    // Not a recoverable class, class-gated off, or no repair seam wired —
    // surface the original bounded error unchanged.
    throw runErr;
  }
  };

  return keepAlive
    ? withDurableKeepAlive(keepAlive.runs, keepAlive.checkpointId, { now: keepAlive.now, logger: log }, runWithRepair)
    : runWithRepair();
}
