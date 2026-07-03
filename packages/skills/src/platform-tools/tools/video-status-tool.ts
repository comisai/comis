// SPDX-License-Identifier: Apache-2.0
/**
 * Video Status tool: check the progress + result of a
 * video-generation job by its job handle.
 *
 * The read side of the async video lifecycle. `video_generate` returns a job
 * handle promptly (the render outlives the turn); the background poller drives
 * it to completion off-turn and announces the finished clip to the channel.
 * `video_status` lets the agent poll the durable terminal state in the meantime.
 *
 * Delegates to the daemon-side `video.status` RPC handler (createVideoStatusHandlers),
 * which reads the agent-scoped VideoJobStore — a job belonging to another agent
 * returns not-found, never the other agent's data.
 *
 * SECURITY: this tool is `mcpExportPolicy:"never-export"` (reserved in
 * tool-metadata-registry.ts) — it reads daemon-side job state and is
 * NOT exposed to external MCP clients. This module only adds the tool descriptor;
 * it does NOT touch the metadata reservation.
 *
 * @module
 */

import { Type } from "typebox";
import { registerActivityLabelSpec } from "@comis/core";
import { createRpcDispatchTool } from "../messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// Activity label spec (§17.6). Descriptor name == emitted name.
registerActivityLabelSpec("video_status", {
  semanticPhase: "media",
  label: "checking video status",
});

const VideoStatusToolParams = Type.Object({
  job_id: Type.String({
    description: "The job handle returned by video_generate.",
  }),
});

/**
 * Create the video_status tool.
 *
 * Uses the createRpcDispatchTool factory to dispatch to the daemon-side
 * video.status RPC handler, which returns `{state, progress?, mediaPath?,
 * costUsd?, error?}` for the job, scoped to the calling agent.
 *
 * @param rpcCall - RPC call function for delegating to the daemon
 * @returns AgentTool that dispatches to video.status
 */
export function createVideoStatusTool(rpcCall: RpcCall) {
  return createRpcDispatchTool({
    name: "video_status",
    label: "Check Video Status",
    description:
      "Check the status/progress of a video generation job by its job handle (returns state, progress, media path, cost).",
    parameters: VideoStatusToolParams,
    rpcMethod: "video.status",
  }, rpcCall);
}
