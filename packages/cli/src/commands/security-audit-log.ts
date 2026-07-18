// SPDX-License-Identifier: Apache-2.0
/**
 * `comis security audit-log` — operator CLI for the durable security-decision
 * audit. Reads `obs_audit_events` via the
 * admin-scoped `obs.audit.query` RPC and prints the content-free rows as a
 * concise table or as JSON.
 *
 * Registered as a SUBCOMMAND on the `comis security` command tree (in
 * `security.ts`, beside `audit`/`fix`) — this flat module holds only the
 * handler, mirroring how `explain.ts`/`system.ts` hold their handlers and call
 * `callTyped(client, Contract, ...)`.
 *
 * Per the `cli-uses-typed-rpc` arch invariant: ONLY `callTyped` is used here —
 * never raw `client.call`. `callTyped` runs `ObsAuditQueryContract.request.parse`
 * on the params and `AuditQueryResponseSchema.parse` on the response.
 *
 * Usage:
 *   comis security audit-log [--kind <k>] [--classification <c>] [--agent <id>]
 *     [--tenant <t>] [--outcome <o>] [--since <ms>] [--until <ms>] [--limit <n>]
 *     [--format table|json]
 *
 * @module
 */

import { ObsAuditQueryContract } from "@comis/core";
import type { AuditQueryResponse, AuditEventRowWire } from "@comis/core";
import { callTyped, isGatewayAuthRejection, withClient } from "../client/rpc-client.js";
import { info, error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";

/** CLI options for `comis security audit-log`. */
export interface AuditLogOptions {
  kind?: string;
  classification?: string;
  agent?: string;
  tenant?: string;
  outcome?: string;
  since?: string;
  until?: string;
  limit?: string;
  format: string;
}

/**
 * Run the `security audit-log` subcommand: query `obs.audit.query` with the
 * provided filters and print the content-free rows. A bounded number-parse:
 * non-numeric `--since`/`--until`/`--limit` are dropped (the contract rejects a
 * NaN), so a typo widens rather than crashes.
 *
 * Exported so `security.ts` attaches it as the subcommand's `.action(...)` and a
 * behavior test can drive it directly.
 */
export async function runAuditLog(options: AuditLogOptions): Promise<void> {
  try {
    const parseNum = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    // Build a sparse params object — an absent filter widens the scan. `tenant`
    // is forwarded even when "" (the system-scope sentinel is a real filter).
    const params = {
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.classification !== undefined ? { classification: options.classification } : {}),
      ...(options.agent !== undefined ? { agentId: options.agent } : {}),
      ...(options.tenant !== undefined ? { tenant: options.tenant } : {}),
      ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
      ...(parseNum(options.since) !== undefined ? { since: parseNum(options.since) } : {}),
      ...(parseNum(options.until) !== undefined ? { until: parseNum(options.until) } : {}),
      ...(parseNum(options.limit) !== undefined ? { limit: parseNum(options.limit) } : {}),
    };

    const response: AuditQueryResponse = await withSpinner(
      "Querying the audit log...",
      () => withClient((client) => callTyped(client, ObsAuditQueryContract, params)),
    );

    if (options.format === "json") {
      json(response);
      return;
    }

    // Table view — content-free columns (counts/ids/enums only; the scrubbed
    // `refs` blob is omitted from the compact table — use --format json to see it).
    if (response.rows.length === 0) {
      info("No audit events match the given filters.");
      return;
    }
    info(`${response.rows.length} audit event(s):`);
    for (const raw of response.rows) {
      // The wire rows ride the loose-record projection; narrow each to the
      // documented content-free row shape (AuditEventRowWire) for rendering.
      const row = raw as unknown as AuditEventRowWire;
      const ts = new Date(row.ts).toISOString();
      const agent = row.agentId ?? "-";
      const cls = row.classification ?? "-";
      const outcome = row.outcome ?? "-";
      const severity = row.severity ?? "-";
      const action = row.action ?? "-";
      info(
        `  ${ts}  [${row.kind}/${cls}]  agent=${agent}  action=${action}  outcome=${outcome}  severity=${severity}`,
      );
    }
  } catch (e) {
    error(`audit-log failed: ${e instanceof Error ? e.message : String(e)}`);
    if (isGatewayAuthRejection(e)) {
      error("tip: the audit log is admin-only — confirm your gateway token carries admin scope");
    }
    process.exit(1);
  }
}
