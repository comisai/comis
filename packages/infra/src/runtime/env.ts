// SPDX-License-Identifier: Apache-2.0
/**
 * Node-backed EnvPort adapter.
 *
 * Reads from the supplied env source (default process.env). The daemon
 * composition root constructs `createSystemEnv(mergedEnv)` after the
 * secret-decryption merge at daemon.ts:546-549 and threads the port
 * into every consumer's deps.
 *
 * Sanctioned runtime root — process.env access here is exempt from
 * the globals architecture rule by classifier.
 *
 * Phase 39, PORTS-06.
 *
 * @module
 */
import type { EnvPort } from "@comis/core";

export function createSystemEnv(
  source: NodeJS.ProcessEnv = process.env,
): EnvPort {
  return {
    get: (key) => source[key],
    snapshot: (keys) => {
      const snap: Record<string, string | undefined> = {};
      for (const key of keys) snap[key] = source[key];
      return Object.freeze(snap);
    },
  };
}
