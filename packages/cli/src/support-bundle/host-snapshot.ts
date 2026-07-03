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
 * `daemonVersion` is the only live-daemon read: a best-effort admin
 * `gateway.status` call, gated on a bounded liveness probe so a dead daemon
 * short-circuits with no network call, and swallowed to undefined on any
 * rejection (auth / transport / parse) — a missing daemon build version is
 * never a failure of the snapshot.
 *
 * @module
 */

import { GatewayStatusContract } from "@comis/core";
import type { HostSnapshot } from "./types.js";
import { readCliVersion } from "../util/cli-version.js";
import { isDaemonRunning as defaultIsDaemonRunning } from "../sync-tooling/daemon-guard.js";
import {
  withClient as defaultWithClient,
  callTyped,
  type RpcClient,
} from "../client/rpc-client.js";

/** Bounded liveness deadline before the daemonVersion probe opens any socket. */
const LIVENESS_TIMEOUT_MS = 1_000;

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
 * Best-effort daemon build version via the admin `gateway.status` read.
 *
 * Gated on a bounded liveness probe so a dead daemon short-circuits with no
 * network call. Returns `undefined` — never throws — when the daemon is down,
 * the admin call is rejected (auth / transport / parse), or the daemon reports
 * no version. The live call goes through `callTyped` so the request and
 * response are validated against the shared contract.
 */
async function collectDaemonVersion(
  deps: CollectHostSnapshotDeps,
): Promise<string | undefined> {
  const isDaemonRunning = deps.isDaemonRunning ?? defaultIsDaemonRunning;
  const withClient = deps.withClient ?? defaultWithClient;

  if (!(await isDaemonRunning(LIVENESS_TIMEOUT_MS))) {
    return undefined;
  }
  try {
    const status = await withClient((client) =>
      callTyped(client, GatewayStatusContract, {}),
    );
    return typeof status.version === "string" ? status.version : undefined;
  } catch {
    // Auth rejection / transport error / contract-parse failure — best-effort,
    // stays undefined so a missing daemon version never fails the snapshot.
    return undefined;
  }
}

/**
 * Collect the content-free `HostSnapshot` for the support bundle.
 *
 * `cliVersion`/`nodeVersion`/`platform`/`arch` are inherent, non-identifying
 * facts; `daemonVersion` is a best-effort live read that is simply absent when
 * the daemon is down or the admin call is rejected. Never throws.
 */
export async function collectHostSnapshot(
  deps: CollectHostSnapshotDeps = {},
): Promise<HostSnapshot> {
  const snapshot: HostSnapshot = {
    cliVersion: readCliVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  const daemonVersion = await collectDaemonVersion(deps);
  if (daemonVersion !== undefined) {
    snapshot.daemonVersion = daemonVersion;
  }

  return snapshot;
}
