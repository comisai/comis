// SPDX-License-Identifier: Apache-2.0
/**
 * steerRun — the live-child inject mechanism for STEER-01 (Phase 175).
 *
 * Extracted from sub-agent-runner.ts (which is over the §2.8 800-line cap) so
 * the heavy mechanism does not grow that file. The runner exposes a thin
 * `steerRun(runId, message)` method that delegates here.
 *
 * MECHANISM (RESEARCH §Pattern 1 + 175-00-SUMMARY A1 resolution):
 *   1. resolve the RUNNING child's live RunHandle via the SAME lookup killRun
 *      uses for abort() — `resolveActiveSession(deriveCompositeForRun(run))`
 *      (sub-agent-runner.ts:1936). The by-sessionKey `activeRunRegistry.get`
 *      is the documented fallback (175-00 confirmed the composite resolves).
 *   2. inject via the channel-path streaming-aware branch (setup-and-route.ts:267):
 *        isStreaming() && !isCompacting() ? handle.steer(msg) : handle.followUp(msg)
 *      — the message lands at the child's NEXT STEP BOUNDARY after transcript
 *      commit (the SDK drains the steering/follow-up queue between turns).
 *
 * NEVER: killRun, spawn, or run.status mutation — the run's identity
 * (runId/transcript/progress) is preserved (kill ≠ steer). A steer is a
 * MESSAGE, never a tool grant — this helper has no path to tool assembly, so
 * the child's spawn-fixed denylist still governs (Task 3 proves the runtime
 * classification a steered denied-tool request hits).
 *
 * Result-shaped per AGENTS.md §2.1 (mirrors killRun's `{killed, error?}` →
 * `{steered, mode?, error?}`); the daemon RPC handler (`@allow-throw`) maps a
 * `!steered` result to a thrown JSON-RPC error.
 *
 * L2 TYPE-SURFACE NOTE: SteerRunDeps declares the FULL `RunHandle`
 * (steer/followUp/isStreaming/isCompacting) — it needs all four. The RUNNER's
 * SubAgentRunnerDeps.sessionResolver/activeRunRegistry are deliberately
 * narrowed to `{ abort(): Promise<void> }` (sub-agent-runner.ts:219-233) to
 * avoid a daemon→agent type-only import cycle in that leaf module. `RunHandle`
 * lives in this SAME package (executor/active-run-registry.ts), so importing
 * it here is intra-package and introduces NO cycle (verified by cycles:refs).
 * The runtime handle is complete (pi-executor.ts:1161 builds all five), so the
 * runner's delegation re-types the resolver/registry to the full RunHandle.
 *
 * @module
 */
import { parseFormattedSessionKey } from "@comis/core";
import type { RunHandle } from "../executor/active-run-registry.js";
import type { SubAgentRun } from "./sub-agent-runner.js";

/** Minimal pino-compatible logger (mirrors SubAgentRunnerLogger). */
interface SteerRunLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Composite key for the resolver lookup. Mirrors `deriveCompositeForRun`
 * (sub-agent-runner.ts:76-87) — duplicated here as a tiny private helper so
 * this leaf module does not import the runner's (large) internals beyond the
 * `SubAgentRun` type. Single source of truth for the FORMULA is the runner's
 * doc-comment; if it drifts, the 175-00 spike fails loudly.
 */
function deriveCompositeForRun(run: SubAgentRun): {
  agentId: string;
  channelType: string;
  channelId: string;
} {
  const parsed = parseFormattedSessionKey(run.sessionKey);
  return {
    agentId: run.agentId,
    channelType: run.announceChannelType ?? "sub-agent",
    channelId: run.announceChannelId ?? parsed?.channelId ?? run.sessionKey,
  };
}

/**
 * Dependencies for {@link steerRun}. The resolver/registry are typed to the
 * FULL RunHandle (unlike the runner's narrowed `{abort()}` deps — see the L2
 * note in the module header).
 */
export interface SteerRunDeps {
  /** READ only — never mutated (no status change, no spawn). */
  runs: Map<string, SubAgentRun>;
  /** Composite-key resolver (the A1-chosen lookup, mirrors killRun). */
  sessionResolver?: {
    resolveActiveSession(key: {
      agentId: string;
      channelType: string;
      channelId: string;
    }): RunHandle | undefined;
  };
  /** By-sessionKey fallback (175-00 documented; composite resolves today). */
  activeRunRegistry?: {
    get(sessionKey: string): RunHandle | undefined;
  };
  logger?: SteerRunLogger;
}

/** Result of an inject attempt (Result-shaped, mirrors killRun). */
export interface SteerRunResult {
  steered: boolean;
  /** Which SDK primitive landed the inject (for the subagent:steered event). */
  mode?: "steer" | "followup";
  /** Set when no live handle / not running — the WARN-able failure branch. */
  error?: string;
}

/**
 * Inject a steer message into the running child's live SDK session.
 *
 * @param deps - run map + resolver/registry lookups + logger
 * @param runId - the target run id
 * @param message - the steer message text (agent-supplied; NEVER logged here)
 * @returns `{steered:true, mode}` on success; `{steered:false, error}` when the
 *   run is unknown or has no live session (the caller throws on `!steered`).
 */
export async function steerRun(
  deps: SteerRunDeps,
  runId: string,
  message: string,
): Promise<SteerRunResult> {
  const run = deps.runs.get(runId);
  if (!run) {
    return { steered: false, error: `Unknown run ID: ${runId}` };
  }

  // Resolve the live handle via the A1-chosen composite lookup (the same lookup
  // killRun uses for abort), falling back to the by-sessionKey registry.
  const handle =
    deps.sessionResolver?.resolveActiveSession(deriveCompositeForRun(run)) ??
    deps.activeRunRegistry?.get(run.sessionKey);
  if (!handle) {
    return {
      steered: false,
      error: `No live session for run ${runId} — cannot inject (use kill, or the run is not running).`,
    };
  }

  // Channel-path streaming-aware branch (setup-and-route.ts:267): steer when
  // the child is mid-stream, else queue a follow-up. Both land at the next step
  // boundary after transcript commit — NO kill, NO respawn, NO state mutation.
  if (handle.isStreaming() && !handle.isCompacting()) {
    await handle.steer(message);
    return { steered: true, mode: "steer" };
  }
  await handle.followUp(message);
  return { steered: true, mode: "followup" };
}
