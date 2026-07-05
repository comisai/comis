// SPDX-License-Identifier: Apache-2.0
/**
 * Replay-handlers contract slice.
 *
 * The single operator-facing deterministic-replay RPC of the durable
 * orchestrate control plane:
 *   - `orchestrate.replay {runId}` — re-run a durable orchestrate run's PINNED
 *     script bytes against a SEPARATE, operator-invoked replay socket that
 *     serves the run's recorded results, and return the byte-identical stdout.
 *     This is NEVER a mode of the production capability endpoint: the handler
 *     starts a physically separate replay socket and points the re-spawned
 *     jail's egress at it, so the authoritative gate stays single-purpose.
 *
 * `scopes:["admin"]` is LOAD-BEARING: the admin set is DERIVED from
 * `scopes:["admin"]` contracts (rpc-dispatch.ts), so this method lands in
 * `ADMIN_METHODS` and the dispatch chokepoint's `assertNotAgentOrigin` denies
 * any agent-origin (`_agentId`-bearing) call automatically — the confused-deputy
 * mitigation for a control-plane replay, with NO manual `_agentId` check
 * anywhere. Mirrors the sibling `autonomy-handlers.ts` (the admin-RPC contract
 * template); the daemon handler drives the replay socket + the pinned-byte
 * re-spawn.
 *
 * The request carries ONLY a `runId` — the operator NEVER supplies script bytes
 * on a replay; the handler re-runs the durable row's pinned `scriptRef` bytes.
 * The response is small + content-free: the recorded stdout the deterministic
 * re-run produced, plus an optional `diverged` flag when the re-run's cap calls
 * did not line up with the recorded results.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// --- replay-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// orchestrate.replay
// ---------------------------------------------------------------------------

/**
 * `orchestrate.replay` — deterministically re-run a durable orchestrate run's
 * pinned script against its recorded results. Admin-scoped → deny-by-origin.
 * Handler path: setup-orchestrate-replay.ts (daemon wiring) + the thin
 * orchestrate-replay-handlers.ts RPC slice.
 *
 * Request: `{ runId }` — the root run id of a durable orchestrate row (a row
 *   carrying a pinned `scriptRef`). The handler validates it against the durable
 *   store before any socket bind / re-spawn; the caller supplies NO script.
 * Response: `{ stdout, diverged? }` — the stdout the pinned-byte re-run produced
 *   against the recorded results (byte-identical to the original for a faithful
 *   run), plus `diverged: true` when a re-run cap call did not match the next
 *   recorded result.
 */
export const OrchestrateReplayContract = defineContract({
  method: "orchestrate.replay",
  request: z.object({
    runId: z.string().min(1),
  }),
  response: z.object({
    stdout: z.string(),
    diverged: z.boolean().optional(),
  }),
  scopes: ["admin"] as const, // → ADMIN_METHODS → deny-by-origin (an agent cannot self-invoke a replay)
});

/**
 * replay-handlers slice (1 contract — orchestrate.replay). Spread order matches
 * the orchestrator contracts array byte for byte — determinism-critical for
 * codegen output stability.
 */
export const REPLAY_HANDLERS_CONTRACTS = [OrchestrateReplayContract] as const;
