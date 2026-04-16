/**
 * SpawnPacketBuilder factory: constructs a SpawnPacket from tool parameters
 * and parent context dependencies.
 *
 * Standalone factory (not coupled to RPC params) so it can be reused by both
 * the sessions_spawn tool path and the GraphCoordinator.
 *
 * @module
 */

import type { SpawnPacket } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected from the parent agent execution context. */
export interface SpawnPacketBuilderDeps {
  /** Parent agent's workspace directory. */
  workspaceDir: string;
  /** Current spawn depth (from session metadata). */
  currentDepth: number;
  /** Maximum allowed spawn depth (from config). */
  maxSpawnDepth: number;
  /** Map of all registered agent IDs to their resolved workspace directories. */
  agentWorkspaces?: Record<string, string>;
}

/** Parameters from the tool call (LLM-provided). */
export interface SpawnPacketBuildParams {
  task: string;
  artifactRefs?: string[];
  objective?: string;
  toolGroups?: string[];
  includeParentHistory?: "none" | "summary";
  domainKnowledge?: string[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SpawnPacketBuilder bound to parent context deps.
 *
 * The returned `build()` method accepts tool-call parameters and produces
 * a `SpawnPacket` with sensible defaults. The `parentSummary` field is left
 * undefined -- it is populated by `executeSubAgent` when
 * `includeParentHistory === "summary"` via `generateParentSummary()`.
 */
export function createSpawnPacketBuilder(deps: SpawnPacketBuilderDeps) {
  return {
    build(params: SpawnPacketBuildParams): SpawnPacket {
      return {
        task: params.task,
        artifactRefs: params.artifactRefs ?? [],
        domainKnowledge: params.domainKnowledge ?? [],
        toolGroups: params.toolGroups ?? [],
        objective: params.objective ?? "",
        workspaceDir: deps.workspaceDir,
        depth: deps.currentDepth,
        maxDepth: deps.maxSpawnDepth,
        agentWorkspaces: deps.agentWorkspaces,
        // parentSummary intentionally left undefined; populated by executeSubAgent
      };
    },
  };
}
