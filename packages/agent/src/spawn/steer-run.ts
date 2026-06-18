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

/** Minimal pino-compatible logger (mirrors SubAgentRunnerLogger). */
interface SteerRunLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The minimal slice of a SubAgentRun this helper reads. Declared locally (NOT
 * imported from sub-agent-runner.ts) so the dependency stays one-directional
 * (runner → helper); importing the runner's `SubAgentRun` type here would form
 * a sub-agent-runner ↔ steer-run source-level cycle (no-cycles.test.ts counts
 * type-only imports). The runner's full SubAgentRun is structurally assignable
 * to this shape, so `runs: Map<string, SubAgentRun>` flows in unchanged.
 */
export interface SteerableRun {
  runId: string;
  agentId: string;
  sessionKey: string;
  announceChannelType?: string;
  announceChannelId?: string;
}

/**
 * Composite key for the resolver lookup. MUST compose, via
 * `BackgroundSessionResolver.formatComposite`, to the EXACT key the executor
 * registers the live handle under (pi-executor.ts:1152-1156):
 *
 *   formatSessionKey({ tenantId: agentId ?? "default",
 *                      channelId: `${originChannelType}:${msg.channelId}`,
 *                      userId: msg.channelId })
 *
 * where for a sub-agent run `originChannelType = deliveryOrigin?.channelType ??
 * channelType ?? "gateway"` and `msg.channelId = subSessionKey.channelId` (the
 * executor ALWAYS receives subSessionKey — sub-agent-runner.ts:1289). So:
 *   - channelType → run.announceChannelType ?? "gateway"  (the executor's
 *     originChannelType: announce runs propagate announceChannelType into ALS as
 *     deliveryOrigin; no-announce runs fall back to "gateway")
 *   - channelId   → the PARSED sub-session channelId (NOT run.announceChannelId
 *     — the executor never keys on the announce channelId; it keys on
 *     subSessionKey.channelId)
 *
 * WR-01 (175-REVIEW.md): the prior formula used `"sub-agent"` for channelType
 * and `run.announceChannelId ?? parsed?.channelId` for channelId, which DIVERGED
 * from the registration key and made `steerRun` return `{steered:false}` for a
 * genuinely-running sub-agent (and made the kill/ghost/watchdog abort lookups
 * silently miss — best-effort there, so latent, but fatal for steer). Mirror the
 * IDENTICAL formula in sub-agent-runner.ts:`deriveCompositeForRun`; the 175-00
 * spike (sub-agent-runner.steer-resolve.spike.test.ts) fails loudly on drift.
 */
function deriveCompositeForRun(run: SteerableRun): {
  agentId: string;
  channelType: string;
  channelId: string;
} {
  const parsed = parseFormattedSessionKey(run.sessionKey);
  return {
    agentId: run.agentId,
    channelType: run.announceChannelType ?? "gateway",
    channelId: parsed?.channelId ?? run.sessionKey,
  };
}

/**
 * Test-only alias for the module-private {@link deriveCompositeForRun}. The
 * 175-00 A1 spike (sub-agent-runner.steer-resolve.spike.test.ts) imports the
 * REAL formula so a drift between it and the executor registration key
 * (pi-executor.ts:1152-1156) fails loudly — NOT a reconstructed replica
 * (WR-01 correction: the old inline replica made the drift guard a tautology).
 * @internal
 */
export const deriveCompositeForRunForTest = deriveCompositeForRun;

/**
 * Dependencies for {@link steerRun}. The resolver/registry are typed to the
 * FULL RunHandle (unlike the runner's narrowed `{abort()}` deps — see the L2
 * note in the module header).
 */
export interface SteerRunDeps {
  /** READ only — never mutated (no status change, no spawn). */
  runs: Map<string, SteerableRun>;
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
