// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws (incl. the Zod request.parse on
// a malformed request) are caught and converted to JSON-RPC error responses by
// rpc-dispatch.ts.
/**
 * Video status RPC handler module (Phase 189 Plan 03 — JOB-04).
 *
 * Provides the `video.status` handler that reads the durable `VideoJobStore` and
 * reports `{state, progress?, mediaPath?, costUsd?, error?}` for a job. This
 * closes the JOB-04 loop: `video.generate` returns a handle (Plan 02), the
 * background poller drives the render off-turn (Plan 02), and `video.status`
 * reports the durable terminal state the poller wrote.
 *
 * AGENT-SCOPED (JOB-04 / TARGET-01 / Pitfall 6 / threat T-189-10): the handler
 * resolves the calling agent EXPLICITLY (`?? "default"`, never silent) and reads
 * the agent-scoped `videoJobStore.get(job_id, agentId)` — which filters by BOTH
 * the jobId AND the agentId. A job belonging to ANOTHER agent matches no row and
 * returns the not-found response (`{state:"failed", error:"No video job <id> for
 * this agent"}`) — NEVER the other agent's mediaPath/cost. The store's not-found
 * is `ok(undefined)` (distinct from a real lookup error), so this handler answers
 * "no such job for this agent" rather than throwing.
 *
 * RES-01 / single-source: this handler is a PURE consumer of the boot-selected
 * store (the SAME `videoJobStore` the poller writes — `buildVideoGenBundle`
 * constructs one instance). It re-derives nothing (the v2.20 keyless-summarizer
 * two-source firewall).
 *
 * The handler key is the computed-property name `[VideoStatusContract.method]`
 * so the bidirectional 1:1 contract↔handler parity gate resolves it through
 * `defineContract({ method, ... })` in `packages/core/src/api-contracts/media.ts`.
 *
 * OBSERVABILITY SCOPE (logger-only): a content-free DEBUG on the not-found branch
 * naming the resolved agentId (TARGET-01) — never the other agent's data. No
 * `video.*` trajectory events (that bridge is OBS-04 / Phase 192).
 *
 * @module
 */

import { VideoStatusContract, stripInternalFields } from "@comis/core";
import type { MediaApiDeps, RpcHandler } from "./types.js";

/** Dependencies the `video.status` RPC handler consumes.
 *
 * Re-aliased from the nested `videoStatusHandlerDeps` sub-shape of the MediaApiDeps
 * cluster slice in api/types.ts (single source of truth; NonNullable — the
 * dispatcher constructs this handler only inside the `deps.videoStatusHandlerDeps
 * ? ...` truthy branch). The read side needs ONLY the store + logger — far
 * narrower than the `video.generate` deps (no provider/persist/deliver/cost). */
export type VideoStatusHandlerDeps = NonNullable<MediaApiDeps["videoStatusHandlerDeps"]>;

/**
 * Create the video status RPC handler.
 * @param deps - The agent-scoped job store + logger.
 * @returns Record mapping "video.status" to its handler function.
 */
export function createVideoStatusHandlers(
  deps: VideoStatusHandlerDeps,
): Record<string, RpcHandler> {
  return {
    [VideoStatusContract.method]: async (rawParams) => {
      // Resolve the agent EXPLICITLY (never a silent default — TARGET-01).
      const agentId = (rawParams._agentId as string) ?? "default";
      // Validate the request (a malformed request — missing job_id — throws here
      // and is converted to a JSON-RPC error by rpc-dispatch; T-189-12).
      const { job_id } = VideoStatusContract.request.parse(stripInternalFields(rawParams));

      // Agent-scoped read — filters by BOTH job_id AND agentId (Pitfall 6 /
      // T-189-10). A cross-agent jobId matches no row → ok(undefined) → not-found.
      const result = await deps.videoJobStore.get(job_id, agentId);
      const job = result.ok ? result.value : undefined;

      if (!job) {
        // Content-free not-found (TARGET-01: state the resolved agentId; the
        // job_id is the opaque, secret-free provider id — echoing it leaks
        // nothing, T-189-12). A real lookup error also lands here as not-found —
        // honest "no such job for this agent" rather than a thrown 500.
        deps.logger.debug(
          { agentId, step: "video_status_not_found", ...(result.ok ? {} : { errorKind: "internal" as const }) },
          "video.status: no job for this agent",
        );
        return { state: "failed", error: `No video job ${job_id} for this agent` };
      }

      // Map the durable record → the contract response. `state` is the domain
      // VideoJobState, which satisfies the z.enum(["pending","done","failed"]).
      // Optional fields are present only when set (mirrors the store's row mapper):
      //   actualCostUsd → costUsd ; lastError → error.
      return {
        state: job.state,
        ...(job.progress !== undefined ? { progress: job.progress } : {}),
        ...(job.mediaPath ? { mediaPath: job.mediaPath } : {}),
        ...(job.actualCostUsd !== undefined ? { costUsd: job.actualCostUsd } : {}),
        ...(job.lastError ? { error: job.lastError } : {}),
      };
    },
  };
}
