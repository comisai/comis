// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — the request.parse throw + the
// runOrchestrateReplaySession content-free throws are caught and converted to
// JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Orchestrate-replay RPC handler slice — the thin operator-facing boundary of
 * the deterministic-replay control plane:
 *
 *   - `orchestrate.replay {runId}` — deterministically re-run a durable
 *     orchestrate run's PINNED script bytes against the SEPARATE, operator-invoked
 *     replay socket that serves the run's recorded results, and return the
 *     byte-identical stdout. The heavy lifting (runId validation, ephemeral-bearer
 *     hygiene, replay-socket lifecycle, the `COMIS_ORCH_SOCKET`-at-the-replay-socket
 *     re-spawn, teardown-in-finally) lives in the sibling
 *     `wiring/setup-orchestrate-replay.ts`; this slice is the thin RPC adapter
 *     (mirrors how the obs handlers delegate to their assemblers).
 *
 * DENY-BY-ORIGIN IS AUTOMATIC — there is NO manual agent-origin check here (it
 * would drift, and the single-chokepoint arch gate forbids per-handler scatter).
 * `orchestrate.replay` is `scopes:["admin"]` → it lands in the DERIVED
 * `ADMIN_METHODS` → the dispatch chokepoint's origin guard (rpc-dispatch.ts)
 * denies any agent-origin (`_agentId`-bearing, non-admin) call BEFORE the handler
 * runs (an agent cannot self-invoke a replay of a run — INV-3). The
 * orchestrate-replay + autonomy-handlers deny-by-origin tests prove the deny on
 * the dispatch path.
 *
 * Per-method pipeline mirrors `autonomy-handlers.ts`: stripInternalFields →
 * request.parse → business logic → dev-mode response.parse. Content-free §2.7
 * logging lives in the wiring module (a byte count + method only — never the
 * stdout body or the bearer).
 *
 * @module
 */
import { OrchestrateReplayContract, stripInternalFields, systemGetEnv } from "@comis/core";

import type { RpcHandler } from "./types.js";
import {
  runOrchestrateReplaySession,
  type OrchestrateReplaySessionDeps,
} from "../wiring/setup-orchestrate-replay.js";

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production"
 * (mirrors autonomy-handlers.ts). The daemon side is the trust boundary; in
 * production the response is trusted from the handler's own logic.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/**
 * Create the orchestrate-replay RPC handlers bound to the given session deps.
 * Spread into the dispatcher alongside the other orchestrator handlers (gated
 * on the replay wiring being present at the composition root).
 */
export function createOrchestrateReplayHandlers(
  deps: OrchestrateReplaySessionDeps,
): Record<string, RpcHandler> {
  return {
    [OrchestrateReplayContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const { runId } = OrchestrateReplayContract.request.parse(userParams);

      // The wiring module owns validation + socket + re-spawn + teardown.
      const result = await runOrchestrateReplaySession(deps, runId);

      if (IS_DEV) OrchestrateReplayContract.response.parse(result);
      return result;
    },
  };
}
