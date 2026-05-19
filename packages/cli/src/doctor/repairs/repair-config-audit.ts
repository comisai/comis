// SPDX-License-Identifier: Apache-2.0
/**
 * `comis doctor --repair` integration: retroactive config-audit
 * scrubber (Plan 45-05 task 13 / design §9.6).
 *
 * Calls the daemon's `config.audit.scrub` RPC to re-run the
 * 45-02 redactor + 45-05 argv-redactor pipeline over the
 * historical config-audit log. The scrubber is idempotent and
 * safe to run unconditionally during repair-mode — it returns
 * `rewrittenRecords: 0` on a clean log.
 *
 * Daemon-not-running is the only common failure mode; doctor.ts
 * surfaces that as `info("SKIPPED: ...")` (not an error) because
 * the operator can re-run doctor when the daemon is back up.
 *
 * @module
 */

import { ConfigAuditScrubContract } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

import { callTyped, withClient } from "../../client/rpc-client.js";

/**
 * Run the config-audit scrubber via the daemon RPC. Returns the
 * list of human-readable action descriptions on success, or an
 * Error on failure.
 *
 * The function does NOT consume any findings — the scrub is
 * unconditional and idempotent. The plan's design §9.6 calls for
 * always-on retroactive scrubbing in repair mode.
 */
export async function repairConfigAudit(): Promise<Result<string[], Error>> {
  try {
    const result = await withClient(async (client) =>
      callTyped(client, ConfigAuditScrubContract, { dryRun: false }),
    );

    if (result.aborted) {
      return ok([
        "Config-audit scrub aborted (concurrent append). Retry when the daemon is quiet.",
      ]);
    }

    const actions: string[] = [];
    if (result.rewrittenRecords > 0 || result.skippedMalformed > 0) {
      actions.push(
        `Config-audit scrub: rewrote ${result.rewrittenRecords} record${result.rewrittenRecords !== 1 ? "s" : ""}, skipped ${result.skippedMalformed} malformed line${result.skippedMalformed !== 1 ? "s" : ""}.`,
      );
    } else {
      actions.push("Config-audit scrub: log already clean (no changes).");
    }
    return ok(actions);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
