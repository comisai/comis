// SPDX-License-Identifier: Apache-2.0
/**
 * Contract surface for sub-agent graph execution.
 *
 * The step-budget floor plus the dependency and callback shapes that
 * `buildExecuteSubAgent` is built against. Kept beside the builder rather than
 * inside it so the signature a caller wires to can be read without the
 * execution body, and so the builder module stays within its size cap.
 *
 * @module
 */
import type {
  AgentCapability,
  AppContainer,
  ConversationLocator,
  FileLockPort,
  SessionKey,
  SessionStorePort,
  WorkspacePolicySnapshot,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { ExecutionResult } from "@comis/agent";
import type { Result } from "@comis/shared";
import type { GitExec } from "@comis/skills/tools";
import type { WorktreeRegistry } from "../setup-worktree-sweep.js";

/** Minimum spawn budget so boot cannot consume every step. */
export const MIN_SUB_AGENT_STEPS = 30;

/** Closure-captured dependencies for executeSubAgent. */
export interface ExecuteSubAgentDeps {
  container: AppContainer;
  sessionStore: Pick<SessionStorePort, "load" | "loadByRef">;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("../setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentExecutor.execute has complex signature crossing package boundaries
  getExecutor: (agentId: string) => { execute: (...args: any[]) => Promise<any> };
  fileLock: FileLockPort;
  logger?: ComisLogger;
  /** Git seam for isolated child worktrees; absence is reported and skips isolation. */
  worktreeGitExec?: GitExec;
  /** Shared registry used by boot and periodic orphan sweeps. */
  worktreeRegistry?: WorktreeRegistry;
}

/** Callback signature accepted by createSubAgentRunner. */
export type ExecuteSubAgentFn = (
  agentId: string,
  sessionKey: SessionKey,
  conversation: ConversationLocator,
  task: string,
  maxSteps?: number,
  callerAgentId?: string,
  graphOverrides?: {
    graphId?: string;
    nodeId?: string;
    reuseConversation?: ConversationLocator;
    graphNodeDepth?: number;
    workspacePolicySnapshot?: WorkspacePolicySnapshot;
  },
  /** Per-spawn token budget — rides executionOverrides into the child's
   *  BudgetGuard per-execution cap. Absent ⇒ no per-execution cap. */
  tokenBudget?: number,
  autonomyContext?: {
    rootRunId: string;
    parentLeaseId?: string;
    parentCaps: readonly AgentCapability[];
    onAssemblyAuthority(authority: {
      rootRunId: string;
      leaseId: string;
      caps: readonly AgentCapability[];
    }): void;
  },
  providerLifecycle?: {
    onProviderStart(): Result<void, Error>;
  },
) => Promise<Pick<ExecutionResult, "response" | "tokensUsed" | "cost" | "finishReason" | "stepsExecuted" | "toolCallHistory" | "terminalErrorKind" | "errorContext"> & { workspaceDir: string }>;
