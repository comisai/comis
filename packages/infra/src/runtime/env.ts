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
 * @module
 */
import type { EnvPort } from "@comis/core";

export function createSystemEnv(
  source: NodeJS.ProcessEnv = process.env,
): EnvPort {
  return {
    get: (key) => source[key],
  };
}
