// SPDX-License-Identifier: Apache-2.0
/** Exact-owner cleanup for background processes left by terminal sub-agents. */

import { systemNowMs, type TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { ProcessRegistry } from "@comis/skills/tools";
import { suppressError } from "@comis/shared";

export interface ChildProcessCleanupDeps {
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
  readonly getRegistry: (agentId: string) => ProcessRegistry | undefined;
}

/** Register child-kill and unresolved-handoff cleanup for daemon lifetime. */
export function setupChildProcessCleanup(deps: ChildProcessCleanupDeps): void {
  function cleanupOwned(params: {
    agentId: string;
    runId: string;
    sessionKey: string;
    trigger: "subagent_killed" | "background_processes_abandoned";
  }): void {
    const registry = deps.getRegistry(params.agentId);
    if (!registry) return;
    const startedAt = systemNowMs();
    const cleanup = registry.killOwned(params.sessionKey).then((result) => {
      if (!result.ok) {
        deps.logger.error(
          {
            agentId: params.agentId,
            runId: params.runId,
            trigger: params.trigger,
            hint: "Inspect the child process registry and stop any remaining process sessions manually",
            errorKind: "internal" as const,
          },
          "Child-owned background process cleanup failed",
        );
        return;
      }
      deps.logger.info(
        {
          agentId: params.agentId,
          runId: params.runId,
          trigger: params.trigger,
          killed: result.value,
          durationMs: Math.max(0, systemNowMs() - startedAt),
        },
        "Killed child-owned background processes",
      );
    });
    suppressError(
      cleanup,
      "sub-agent child-owned background process cleanup",
      (message) => deps.logger.error(
        {
          agentId: params.agentId,
          runId: params.runId,
          trigger: params.trigger,
          hint: "Inspect the child process registry and stop any remaining process sessions manually",
          errorKind: "internal" as const,
        },
        message,
      ),
    );
  }

  deps.eventBus.on("subagent:killed", (payload) => cleanupOwned({
    agentId: payload.agentId,
    runId: payload.runId,
    sessionKey: payload.sessionKey,
    trigger: "subagent_killed",
  }));
  deps.eventBus.on("subagent:background_processes_abandoned", (payload) => cleanupOwned({
    agentId: payload.agentId,
    runId: payload.runId,
    sessionKey: payload.sessionKey,
    trigger: "background_processes_abandoned",
  }));
}
