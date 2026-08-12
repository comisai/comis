// SPDX-License-Identifier: Apache-2.0
/**
 * `obs.quarantine.list` / `obs.quarantine.release` — the operator lever over
 * quarantined background-task announcements.
 *
 * These MUST go through the daemon rather than the JSONL on disk: the running
 * queue holds its state in memory and rewrites the file from it on the next
 * persist, so an operator editing the file under a live daemon has their change
 * silently undone. The daemon is the only authority while it is up.
 *
 * Absent queue (a daemon wired without cross-session delivery) degrades
 * honestly — an empty list and a `released:false` — never a silent success that
 * would tell an operator a stuck announcement was cleared when nothing was.
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import {
  ObsQuarantineListContract,
  ObsQuarantineReleaseContract,
  stripInternalFields,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

/** Admin gate (defense-in-depth; the gateway router is the primary gate). */
function requireAdmin(rawParams: unknown): void {
  const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
  if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");
}

/** Bind both quarantine handlers. Computed-key form is required by the parity tests. */
export function bindObsQuarantineHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  return {
    [ObsQuarantineListContract.method]: async (rawParams) => {
      requireAdmin(rawParams);
      ObsQuarantineListContract.request.parse(stripInternalFields(rawParams));

      const rows = deps.deadLetterQueue?.listQuarantined() ?? [];
      // The rows are content-free by construction (the port carries
      // `announcementChars`, never the text), so they ride the loose-record
      // wire projection directly — the same narrowing the sibling obs.* reads use.
      const result = { rows: rows.map((row) => ({ ...row })), total: rows.length };
      if (IS_DEV) ObsQuarantineListContract.response.parse(result);
      return result;
    },

    [ObsQuarantineReleaseContract.method]: async (rawParams) => {
      requireAdmin(rawParams);
      const params = ObsQuarantineReleaseContract.request.parse(stripInternalFields(rawParams));

      const queue = deps.deadLetterQueue;
      if (queue === undefined) {
        const empty = { released: false, remaining: 0 };
        if (IS_DEV) ObsQuarantineReleaseContract.response.parse(empty);
        return empty;
      }

      const released = await queue.release(params.id, params.outcome);
      // A storage failure must surface: reporting `released:false` here would be
      // indistinguishable from an unknown id, and the operator would believe the
      // announcement was already gone while it is still parked.
      if (!released.ok) throw released.error;

      const result = { released: released.value, remaining: queue.size() };
      if (IS_DEV) ObsQuarantineReleaseContract.response.parse(result);
      return result;
    },
  };
}
