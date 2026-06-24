// SPDX-License-Identifier: Apache-2.0
/**
 * Built-but-not-wired SOURCE GUARD for the autonomy REVOKE control plane
 * (Phase 213-06: `lease.revoke` + `run.kill`). Mirrors `audio-wiring-guard.test.ts`.
 *
 * LIVE FINDING (VPS, openai-codex, 2026-06-23): with the capability lease layer
 * ACTIVE ("lease minted per spawn", cap socket bound), `lease.revoke` and
 * `run.kill` both returned **"Unknown RPC method"** — so REVOKE, the design's
 * "live control" differentiator (revoke a lease / kill a run-tree, external to and
 * non-bypassable by the agent), was UNREACHABLE live.
 *
 * Root cause: `createRpcDispatch` (rpc-dispatch.ts) registers the autonomy
 * handlers ONLY when `deps.leaseManager` is wired, and registers
 * `capabilities.introspect` ONLY when `deps.boundedAutonomy` is wired. The
 * dispatch-deps assembly (`buildRpcDispatchDeps` in daemon.ts) threaded
 * `boundedAutonomy: c.capEndpointHandle?.boundedAutonomy` (so `whoami` worked) but
 * NEVER threaded `leaseManager` from the SAME `capEndpointHandle` — so
 * `deps.leaseManager` was `undefined` and the revoke/kill handlers silently never
 * registered. The handlers + LeaseManager pass their own unit tests; only the LIVE
 * wiring was missing — the program's #1 recurring blocker class.
 *
 * This guard pins the live wiring: `buildRpcDispatchDeps` must thread BOTH
 * `boundedAutonomy` AND `leaseManager` from `capEndpointHandle`. A refactor that
 * drops the leaseManager thread turns this red.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DAEMON_TS = resolve(REPO_ROOT, "packages/daemon/src/daemon.ts");
const RPC_DISPATCH_TS = resolve(REPO_ROOT, "packages/daemon/src/api/rpc-dispatch.ts");

/** Strip line + block comments so a token inside a comment cannot satisfy a
 *  wiring assertion (a comment naming leaseManager is NOT the wiring). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

describe("autonomy REVOKE (lease.revoke / run.kill) built-but-not-wired source guard", () => {
  it("rpc-dispatch gates the autonomy handlers on deps.leaseManager (sanity: the gate that needs the thread)", () => {
    const code = stripComments(readFileSync(RPC_DISPATCH_TS, "utf8"));
    // The autonomy handlers (lease.revoke + run.kill) register ONLY when
    // deps.leaseManager is truthy — so the dispatch-deps assembly MUST set it.
    expect(code).toMatch(/deps\.leaseManager\s*\n?\s*\?\s*createAutonomyHandlers|deps\.leaseManager\s*\?/);
  });

  it("daemon.ts threads BOTH boundedAutonomy AND leaseManager from capEndpointHandle into the dispatch deps", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // boundedAutonomy IS threaded (this is why capabilities.introspect/whoami works).
    expect(code).toMatch(/boundedAutonomy:\s*c\.capEndpointHandle\?\.boundedAutonomy/);
    // leaseManager from the SAME handle MUST be threaded too — else lease.revoke /
    // run.kill never register and REVOKE is unreachable live (the live VPS finding).
    expect(code).toMatch(/leaseManager:\s*c\.capEndpointHandle\?\.leaseManager/);
  });
});
