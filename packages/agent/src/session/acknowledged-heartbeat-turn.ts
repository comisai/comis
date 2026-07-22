// SPDX-License-Identifier: Apache-2.0
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { replaceSessionActiveBranch } from "./session-manager-internals.js";

export interface AcknowledgedHeartbeatTurnPruneError {
  readonly errorKind: "precondition" | "resource";
  readonly message: string;
}

/** Remove the newest complete synthetic heartbeat turn while its session lock is held. */
export function pruneAcknowledgedHeartbeatTurn(
  sessionManager: SessionManager,
): Result<void, AcknowledgedHeartbeatTurnPruneError> {
  const branch = tryCatch(() => sessionManager.getBranch());
  if (!branch.ok) {
    return err({ errorKind: "resource", message: "Heartbeat session branch could not be read" });
  }
  const start = findNewestUserIndex(branch.value);
  if (start === -1 || !hasAssistantAfter(branch.value, start)) {
    return err({
      errorKind: "precondition",
      message: "Heartbeat session does not end in a complete user and assistant turn",
    });
  }
  const replaced = replaceSessionActiveBranch(sessionManager, branch.value.slice(0, start));
  return replaced.ok
    ? ok(undefined)
    : err({ errorKind: "resource", message: "Heartbeat session turn could not be removed" });
}

function findNewestUserIndex(branch: readonly SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (entry.type === "message" && entry.message.role === "user") return index;
  }
  return -1;
}

function hasAssistantAfter(branch: readonly SessionEntry[], start: number): boolean {
  for (let index = start + 1; index < branch.length; index += 1) {
    const entry = branch[index]!;
    if (entry.type === "message" && entry.message.role === "assistant") return true;
  }
  return false;
}
