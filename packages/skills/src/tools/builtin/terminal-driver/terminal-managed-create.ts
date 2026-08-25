// SPDX-License-Identifier: Apache-2.0

import { err, ok, type Result } from "@comis/shared";
import type { TerminalScope } from "./allowlist-matcher.js";

export type ManagedHandleSelection =
  | { readonly kind: "ordinary" }
  | { readonly kind: "invalid"; readonly reason: "pair_required" | "format_invalid" }
  | {
      readonly kind: "managed";
      readonly managedRunId: string;
      readonly workspaceLeaseId: string;
    };

const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

/** Read the paired opaque handles without ever accepting a caller-supplied path. */
export function selectManagedHandles(params: Readonly<Record<string, unknown>>): ManagedHandleSelection {
  const managedRunId = typeof params.managedRunId === "string" ? params.managedRunId : undefined;
  const workspaceLeaseId = typeof params.workspaceLeaseId === "string" ? params.workspaceLeaseId : undefined;
  if (managedRunId === undefined && workspaceLeaseId === undefined) return { kind: "ordinary" };
  if (!managedRunId || !workspaceLeaseId) return { kind: "invalid", reason: "pair_required" };
  if (
    managedRunId.length > 256
    || workspaceLeaseId.length > 256
    || !OPAQUE_HANDLE_PATTERN.test(managedRunId)
    || !OPAQUE_HANDLE_PATTERN.test(workspaceLeaseId)
  ) return { kind: "invalid", reason: "format_invalid" };
  return { kind: "managed", managedRunId, workspaceLeaseId };
}

/** Explain why a managed handle pair cannot be used without exposing either handle. */
export function managedHandleSelectionError(reason: "pair_required" | "format_invalid"): string {
  return reason === "pair_required"
    ? "managedRunId and workspaceLeaseId must be provided together"
    : "managed terminal handles are invalid; copy both exact handles from a fresh launch plan";
}

/**
 * A managed run sees only its leased filesystem root while retaining the
 * operator-reviewed network, read-only credential-bind, and uid policy.
 */
export function narrowManagedTerminalScope(scope: TerminalScope): TerminalScope {
  return {
    filesystem: "workspace",
    network: scope.network,
    credentialPaths: [...scope.credentialPaths],
    ephemeralWritablePaths: [...scope.ephemeralWritablePaths],
    uid: scope.uid,
    ...(scope.hosts === undefined ? {} : { hosts: scope.hosts }),
  };
}

interface ManagedWorkspaceGitPreparationDeps {
  readonly prepareManagedWorkspaceGit?: (workspace: string) => Result<void, Error>;
  readonly logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly eventBus: {
    emit(event: "terminal:spawn_failed", payload: {
      sessionId: string;
      agentId: string;
      hint: string;
      errorKind: string;
      timestamp: number;
    }): unknown;
  };
  readonly nowMs: () => number;
  readonly agentId: string;
}

/** Prepare private Git before reservation and record an actionable failure at this boundary. */
export function prepareManagedTerminalWorkspaceGit(
  deps: ManagedWorkspaceGitPreparationDeps,
  workspace: string,
  allowId: string,
  startedAt: number,
): Result<void, { readonly message: string; readonly hint: string }> {
  const prepared = deps.prepareManagedWorkspaceGit?.(workspace);
  if (prepared?.ok === true) return ok(undefined);
  const failedAt = deps.nowMs();
  const hint =
    "recreate the workspace lease from a valid linked Git worktree owned by the Comis service user; no terminal was reserved or spawned";
  deps.logger.warn(
    {
      toolName: "terminal_session_create",
      allowId,
      durationMs: failedAt - startedAt,
      hint,
      errorKind: "precondition" as const,
      step: "managed-git-prepare",
    },
    "managed terminal workspace Git preparation failed",
  );
  deps.eventBus.emit("terminal:spawn_failed", {
    sessionId: "",
    agentId: deps.agentId,
    hint,
    errorKind: "precondition",
    timestamp: failedAt,
  });
  return err({
    message: prepared === undefined
      ? "managed terminal workspace Git preparation failed: daemon preparation is unavailable"
      : `managed terminal workspace Git preparation failed: ${prepared.error.message}`,
    hint,
  });
}
