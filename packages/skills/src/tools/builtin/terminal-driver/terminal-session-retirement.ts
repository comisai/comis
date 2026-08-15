// SPDX-License-Identifier: Apache-2.0
/** Durable terminal end-of-life state machine shared by kill, reaper, exit, and cleanup. */
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import type { TerminalDurabilityDeps } from "./terminal-session-reattach.js";
import type { RegistryLogger, SessionHandle } from "./terminal-session-types.js";

export interface TerminalSessionRetirementDeps {
  readonly sessions: Map<string, SessionHandle>;
  readonly durability?: TerminalDurabilityDeps;
  readonly cleanupWorkspace: (workspace: string) => void;
  readonly logger: RegistryLogger;
  readonly terminateWorker: (handle: SessionHandle) => Promise<Result<void, Error>>;
  readonly sendWorkerKill: (handle: SessionHandle) => void;
}

export interface TerminalSessionRetirement {
  isManagedHandle(handle: SessionHandle): boolean;
  dropSession(handle: SessionHandle, message: string): Result<void, Error>;
  retireManagedExit(handle: SessionHandle): Promise<void>;
  terminateRetireAndDropManaged(handle: SessionHandle): Promise<Result<void, Error>>;
  evictInternal(handle: SessionHandle): Promise<Result<void, Error>>;
  terminateAndConfirm(handle: SessionHandle): Promise<Result<void, Error>>;
}

export function createTerminalSessionRetirement(
  deps: TerminalSessionRetirementDeps,
): TerminalSessionRetirement {
  function isManagedHandle(handle: SessionHandle): boolean {
    return handle.managedRunId !== undefined
      || handle.workspaceLeaseId !== undefined
      || handle.serviceInstanceId !== undefined;
  }

  function dropSession(handle: SessionHandle, message: string): Result<void, Error> {
    const { sessionId } = handle;
    if (handle.durable === true) {
      const removed = deps.durability?.descriptorStore?.remove(sessionId);
      if (removed !== undefined && !removed.ok) return removed;
    }
    deps.sessions.delete(sessionId);
    if (handle.workspace !== undefined) deps.cleanupWorkspace(handle.workspace);
    deps.logger.info({ sessionId }, message);
    return ok(undefined);
  }

  function confirmDetachedTmuxTermination(handle: SessionHandle): Result<void, Error> {
    const tmuxName = handle.tmuxName;
    if (handle.durable !== true || tmuxName === undefined) return ok(undefined);
    const killTmuxSession = deps.durability?.killTmuxSession;
    if (killTmuxSession === undefined) {
      return err(new Error("detached tmux termination authority is unavailable"));
    }
    const invoked = tryCatch(() => killTmuxSession(tmuxName, handle.tmuxSocket));
    return invoked.ok ? invoked.value : err(invoked.error);
  }

  async function retireManagedExit(handle: SessionHandle): Promise<void> {
    const { sessionId, managedRunId, workspaceLeaseId, serviceInstanceId } = handle;
    const retireManagedSession = deps.durability?.retireManagedSession;
    if (
      managedRunId === undefined
      || workspaceLeaseId === undefined
      || serviceInstanceId === undefined
      || retireManagedSession === undefined
    ) {
      deps.logger.warn(
        { sessionId, hint: "restore the exact managed terminal retirement authority before cleanup", errorKind: "resource" as const },
        "managed terminal exit retained its durable descriptor",
      );
      return;
    }
    const terminated = confirmDetachedTmuxTermination(handle);
    if (!terminated.ok) {
      deps.logger.warn(
        { sessionId, hint: "confirm detached tmux termination before retiring managed authority", errorKind: "resource" as const },
        "managed terminal natural exit retained its durable authority",
      );
      return;
    }
    const invoked = await fromPromise(retireManagedSession({
      managedRunId,
      workspaceLeaseId,
      serviceInstanceId,
      terminalSessionId: sessionId,
      transition: "exited",
    }));
    if (invoked.ok && invoked.value.ok) {
      const removed = deps.durability?.descriptorStore?.remove(sessionId);
      if (removed !== undefined && !removed.ok) {
        deps.logger.warn(
          { sessionId, hint: "retry descriptor deletion before reclaiming managed terminal authority", errorKind: "resource" as const },
          "managed terminal exit descriptor deletion failed",
        );
      }
      return;
    }
    deps.logger.warn(
      { sessionId, hint: "retry durable terminal retirement before removing its descriptor", errorKind: "resource" as const },
      "managed terminal exit retirement failed",
    );
  }

  async function terminateRetireAndDropManaged(handle: SessionHandle): Promise<Result<void, Error>> {
    const { sessionId, managedRunId, workspaceLeaseId, serviceInstanceId } = handle;
    if (managedRunId === undefined || workspaceLeaseId === undefined || serviceInstanceId === undefined) {
      return err(new Error("managed terminal retirement identity is unavailable"));
    }
    const retireManagedSession = deps.durability?.retireManagedSession;
    if (retireManagedSession === undefined) {
      return err(new Error("managed terminal durable retirement is unavailable"));
    }
    const workerTerminated = await deps.terminateWorker(handle);
    if (!workerTerminated.ok) return workerTerminated;
    const tmuxTerminated = confirmDetachedTmuxTermination(handle);
    if (!tmuxTerminated.ok) return tmuxTerminated;
    const invoked = await fromPromise(retireManagedSession({
      managedRunId,
      workspaceLeaseId,
      serviceInstanceId,
      terminalSessionId: sessionId,
      transition: "released",
    }));
    if (!invoked.ok) return err(invoked.error);
    if (!invoked.value.ok) return invoked.value;
    return dropSession(handle, "managed terminal termination and retirement confirmed");
  }

  async function evictInternal(handle: SessionHandle): Promise<Result<void, Error>> {
    if (isManagedHandle(handle)) return terminateRetireAndDropManaged(handle);
    if (handle.status === "running") deps.sendWorkerKill(handle);
    const terminated = confirmDetachedTmuxTermination(handle);
    return terminated.ok ? dropSession(handle, "terminal session killed") : terminated;
  }

  async function terminateAndConfirm(handle: SessionHandle): Promise<Result<void, Error>> {
    if (isManagedHandle(handle)) return terminateRetireAndDropManaged(handle);
    const workerTerminated = await deps.terminateWorker(handle);
    if (!workerTerminated.ok) return workerTerminated;
    const tmuxTerminated = confirmDetachedTmuxTermination(handle);
    return tmuxTerminated.ok
      ? dropSession(handle, "terminal session termination confirmed")
      : tmuxTerminated;
  }

  return {
    isManagedHandle,
    dropSession,
    retireManagedExit,
    terminateRetireAndDropManaged,
    evictInternal,
    terminateAndConfirm,
  };
}
