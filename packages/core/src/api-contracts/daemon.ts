// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-domain RPC contracts. Mirrors
 * `packages/daemon/src/api/daemon-handlers.ts`.
 *
 * The daemon-handlers.ts factory currently exposes only 2 methods —
 * `system.ping` and `daemon.setLogLevel`. Other methods (`gateway.status`,
 * `gateway.restart`, `obs.diagnostics`) live in different handler factory
 * files (`config-handlers.ts` for gateway.*, `obs-handlers.ts` for
 * obs.diagnostics). One contract file per handler factory file — those
 * methods get their own per-domain contract files.
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
 * (see daemon-handlers.ts:29-32).
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
