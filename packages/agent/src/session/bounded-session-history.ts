// SPDX-License-Identifier: Apache-2.0
/** Generic bounded retention for the active SDK conversation branch. */
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { err, ok, type Result } from "@comis/shared";
import {
  getSessionFileEntries,
  replaceSessionActiveBranch,
} from "./session-manager-internals.js";

export interface BoundedSessionHistoryError {
  errorKind: "validation" | "precondition" | "resource";
  message: string;
}

export interface BoundedSessionHistoryResult {
  retainedTurns: number;
  removedEntries: number;
}

interface CompleteTurn {
  start: number;
  end: number;
}

export function retainLastCompleteUserTurns(
  sessionManager: SessionManager,
  maxHistoryTurns: number,
): Result<BoundedSessionHistoryResult, BoundedSessionHistoryError> {
  if (!Number.isSafeInteger(maxHistoryTurns) || maxHistoryTurns < 1 || maxHistoryTurns > 20) {
    return err({
      errorKind: "validation",
      message: "History turn bound must be between 1 and 20",
    });
  }
  const fileEntries = getSessionFileEntries(sessionManager);
  if (fileEntries === undefined) {
    return err({
      errorKind: "precondition",
      message: "SDK session entries are unavailable",
    });
  }
  const activeBranch = sessionManager.getBranch();
  const completeTurns = findCompleteTurns(activeBranch);
  const selected = completeTurns.slice(-maxHistoryTurns);
  const retained = selected.length === 0
    ? []
    : activeBranch.slice(selected[0]!.start, selected.at(-1)!.end + 1)
      .map((entry, index, entries) => ({
        ...entry,
        parentId: index === 0 ? null : entries[index - 1]!.id,
      } as SessionEntry));
  const existingEntryCount = fileEntries.filter((entry) => entry.type !== "session").length;
  const replaced = replaceSessionActiveBranch(sessionManager, retained);
  if (!replaced.ok) {
    return err({ errorKind: "resource", message: replaced.error.message });
  }
  return ok({
    retainedTurns: selected.length,
    removedEntries: Math.max(0, existingEntryCount - retained.length),
  });
}

function findCompleteTurns(branch: readonly SessionEntry[]): CompleteTurn[] {
  const starts: number[] = [];
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index]!;
    if (entry.type === "message" && entry.message.role === "user") starts.push(index);
  }
  const complete: CompleteTurn[] = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!;
    const end = (starts[index + 1] ?? branch.length) - 1;
    let hasAssistant = false;
    for (let cursor = start + 1; cursor <= end; cursor++) {
      const entry = branch[cursor]!;
      if (entry.type === "message" && entry.message.role === "assistant") {
        hasAssistant = true;
        break;
      }
    }
    if (hasAssistant) complete.push({ start, end });
  }
  return complete;
}
