// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills context-tools barrel — the public surface the daemon wiring
 * (composition root, `setup-tools.ts`) consumes: the three in-session
 * expansion-loop AgentTool factories (`ctx_search` / `ctx_inspect` /
 * `ctx_expand`) + the shared `ContextToolDeps` it constructs.
 *
 * Re-exported through `../../index.js` (the `./tools` subpath). These are
 * DIRECT-INJECTION, never-export, owner-scoped tools that read the injected
 * core `ContextStorePort` — structurally distinct from the RPC recall path
 * (session-search / memory-search): no RPC call, no recall dispatch, and no
 * cross-package memory import anywhere in this directory.
 *
 * @module
 */

export { createCtxSearchTool } from "./ctx-search-tool.js";
export { createCtxInspectTool } from "./ctx-inspect-tool.js";
export { createCtxExpandTool } from "./ctx-expand-tool.js";
export {
  type ContextToolDeps,
  type ToolLogger as ContextToolLogger,
} from "./context-tools-shared.js";
// DEPTH-02: the tier→multi-hop-depth map, consumed by the daemon wiring site to
// resolve `maxExpandDepth` from the agent's ModelProfile capabilityClass.
export { depthForTier, type WalkCapabilityClass } from "./ctx-expand-walk.js";
