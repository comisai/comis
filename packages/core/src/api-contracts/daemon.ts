// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-domain RPC contracts. Mirrors
 * `packages/daemon/src/api/daemon-handlers.ts`.
 *
 * Phase 35 Wave C kickoff (Plan 35-06). The daemon-handlers.ts factory
 * currently exposes only 2 methods — `system.ping` and `daemon.setLogLevel`
 * (see file header comment in daemon-handlers.ts: "Covers: system.ping --
 * Health check / liveness probe AND daemon.setLogLevel -- Runtime log
 * level changes"). The plan's <interfaces> block additionally cited
 * `gateway.status`, `gateway.restart`, and `obs.diagnostics` — but those
 * methods live in DIFFERENT handler factory files
 * (`config-handlers.ts` for gateway.*, `obs-handlers.ts` for
 * obs.diagnostics). Per D-08 (one contract file per handler factory file),
 * they will land in their own per-domain Wave C plans (35-07+) — NOT here.
 *
 * Plan 35-06 thus delivers the SMALLEST domain (2 contracts) which is
 * still the right vehicle for proving the Wave C pattern (contract
 * creation → handler refactor → CLI client wrapper).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// daemon.setLogLevel
// ---------------------------------------------------------------------------

/**
 * Valid Pino log levels. "silent" is intentionally excluded — it suppresses
 * all logging including security events. Operators who need it can set it
 * in YAML config. Mirrors the validation in
 * `packages/daemon/src/api/daemon-handlers.ts`.
 */
const PinoLogLevelEnum = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

export const DaemonSetLogLevelContract = defineContract({
  method: "daemon.setLogLevel",
  request: z.object({
    level: PinoLogLevelEnum,
    module: z.string().optional(),
  }),
  // Response shape captures BOTH variants the handler returns:
  // - global scope: { updated, level, scope: "global", persistent }
  // - module scope: { updated, module, level, scope: "module", persistent }
  // The `module` and `scope` fields differ between the two; model `module`
  // as optional (present only in module-scoped responses) and `scope` as
  // a union of the two literal strings.
  response: z.object({
    updated: z.literal(true),
    module: z.string().optional(),
    level: z.string(),
    scope: z.enum(["global", "module"]),
    persistent: z.literal(false),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// system.ping
// ---------------------------------------------------------------------------

/**
 * Health-check / liveness probe. Handler returns `{ pong: true, ts: <ms> }`
 * (see daemon-handlers.ts:29-32). Note: NOT `{ ok: true, time: number }` as
 * the plan template suggested — the actual handler shape was confirmed by
 * reading daemon-handlers.ts.
 */
export const SystemPingContract = defineContract({
  method: "system.ping",
  request: z.object({}),
  response: z.object({
    pong: z.literal(true),
    ts: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — appended to API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

export const DAEMON_CONTRACTS = [
  DaemonSetLogLevelContract,
  SystemPingContract,
] as const;
