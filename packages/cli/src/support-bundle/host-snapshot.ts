// SPDX-License-Identifier: Apache-2.0
/**
 * Caller-side collection of the content-free `HostSnapshot` that feeds the
 * support triage. Collecting here (not inside the reducer) keeps the reducer
 * pure — it receives an already-built snapshot.
 *
 * Content-free by construction: `cliVersion` from the shared package.json
 * reader and `nodeVersion`/`platform`/`arch` from `process.*` — inherent,
 * non-identifying host facts. Deliberately excludes the host name, any
 * environment value, and all repository state, so no host-enumerating field
 * can leak into a pasted bundle (omission beats hashing).
 *
 * `daemonVersion` is the only live-daemon read and is added as a best-effort
 * probe through the injectable `deps` seam below.
 *
 * @module
 */

import type { HostSnapshot } from "./types.js";
import { readCliVersion } from "../util/cli-version.js";
import type { RpcClient } from "../client/rpc-client.js";

/**
 * Injection seam for the best-effort `daemonVersion` probe. Both hooks default
 * to the real daemon-guard / RPC-client functions in production; tests pass
 * stubs to drive the daemon-up / daemon-down / rejection paths without a live
 * daemon (the real `withClient` refuses to open a socket under test).
 */
export interface CollectHostSnapshotDeps {
  isDaemonRunning?: (timeoutMs?: number) => Promise<boolean>;
  withClient?: <T>(fn: (client: RpcClient) => Promise<T>) => Promise<T>;
}

/**
 * Collect the content-free `HostSnapshot` for the support bundle.
 *
 * `cliVersion`/`nodeVersion`/`platform`/`arch` are inherent, non-identifying
 * facts. Never throws.
 */
export async function collectHostSnapshot(
  _deps: CollectHostSnapshotDeps = {},
): Promise<HostSnapshot> {
  return {
    cliVersion: readCliVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}
