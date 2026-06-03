// SPDX-License-Identifier: Apache-2.0
// @allow-throw: SEC-16 fail-closed control flow — JailUnavailableError signals "no jail can be materialized" (no bwrapPath / no listed-hosts egress port); the worker's dispatch boundary catches it and maps it to an ok:false create reply (the registry flips the session lost). Never an unjailed fallback.
/**
 * buildSpawnPlan -- the 122-06 scope-jail COMPOSITION seam, extracted out of the
 * worker so `terminal-worker-entry.ts` stays under the 800-line architecture cap.
 *
 * It composes the three already-built primitives into the exact `pty.spawn` /
 * `spawnPipe` arguments the worker uses to run the driven child INSIDE a bwrap
 * jail (the 118 G-2 composition: PTY-master-in-worker -> bwrap -> child):
 *
 *   1. {@link buildScopeArgs} (122-03) -> `[bwrapPath, ...scopeArgs, "--"]`
 *      materializing the entry's `scope` (filesystem/network/uid + credentialHome
 *      + the always-on ~/.comis carve-out).
 *   2. {@link scrubChildEnv} (122-02) -> the child env (bwrap forwards the spawner
 *      env, no --clearenv, so the scrubbed env IS the child env). For
 *      `network: listed-hosts` the relay's `proxyEnv` (HTTPS_PROXY/HTTP_PROXY) is
 *      merged over it.
 *   3. For `network: listed-hosts`: {@link EgressControlPort.materialize} stands up
 *      the host-side allowlist proxy socket, {@link buildEgressRelayLaunch} (122-05)
 *      builds the in-jail relay-as-init wrapper, the socket is bind-mounted via the
 *      composer's `relaySocketPath`, and the relay wrapper is inserted between
 *      bwrap's `--` and the child. The returned {@link EgressMaterialization} rides
 *      back so the worker disposes it on session teardown.
 *
 * Fail-closed (SEC-16) on the REAL scope path: if `bwrapPath` is undefined (no
 * provider materialized a jail) this REJECTS — it never returns a bare/unjailed
 * spawn. The worker turns the rejection into an `ok:false` create reply (the
 * registry flips the session `lost`). There is NO dual path.
 *
 * This module is INFRA-FREE: it imports the {@link EgressControlPort} as a TYPE
 * from @comis/core and value-imports only the sibling skills composers — never
 * @comis/infra (the architecture test names the terminal scope/egress files as
 * infra-free; this is one more on that boundary).
 *
 * @module
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";

import { safePath, type EgressControlPort, type EgressMaterialization } from "@comis/core";

import type { TerminalScope } from "./allowlist-matcher.js";
import {
  buildScopeArgs as defaultBuildScopeArgs,
  SYSTEM_RO_PATHS,
} from "./terminal-scope-args.js";
import { scrubChildEnv as defaultScrubChildEnv } from "./terminal-env-scrub.js";
import {
  buildEgressRelayLaunch as defaultBuildEgressRelayLaunch,
  type EgressRelayLaunch,
} from "./terminal-egress-relay.js";

/**
 * The net-new uid/gid the dedicated-uid posture drops to inside the jail
 * (`nobody`/`nogroup`). Net-new vs the daemon uid (SEC-02) — proven on the VPS in
 * the 118 spike. Applied only when `scope.uid === "dedicated"` (the default).
 */
export const DEDICATED_UID = { uid: 65534, gid: 65534 } as const;

/**
 * The loopback TCP port the in-jail egress relay listens on for
 * `network: listed-hosts`, exposed to the child as
 * `HTTPS_PROXY=http://127.0.0.1:<port>`. The netns is isolated (`--unshare-net`),
 * so this jail-local port can never collide with a host port.
 */
export const RELAY_LOOPBACK_PORT = 13128 as const;

/**
 * The least-privilege default scope (SEC-02) applied when a create frame carries
 * no `scope` — workspace-only fs, deny-all egress, no credential home, a net-new
 * uid. Defense-in-depth: the daemon already defaults every scope sub-field via the
 * config schema; the worker never assumes a widened scope from an absent field.
 */
export const LEAST_PRIVILEGE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialHome: "exclude",
  uid: "dedicated",
};

/**
 * The composers the worker injects (defaults = the 122-02/03/05 module exports).
 * The egress port is injected by the daemon (a concrete {@link EgressControlPort});
 * `bwrapPath` is the resolved provider path (undefined ⇒ fail-closed).
 */
export interface SpawnPlanComposers {
  buildScopeArgs?: typeof defaultBuildScopeArgs;
  scrubChildEnv?: typeof defaultScrubChildEnv;
  buildEgressRelayLaunch?: typeof defaultBuildEgressRelayLaunch;
  /** The daemon-injected egress port (no-secret allowlist proxy). listed-hosts only. */
  egressControl?: EgressControlPort;
  /** The resolved bwrap binary path. `undefined` ⇒ {@link buildSpawnPlan} rejects (SEC-16). */
  bwrapPath?: string;
}

/** The session geometry + identity the plan needs (off the create frame, 122-01). */
export interface SpawnPlanInput {
  /** The operator-declared scope (least-privilege default applied upstream). */
  scope: TerminalScope;
  /** The driven command (daemon-canonical, M-1) — placed verbatim AFTER bwrap's `--`. */
  bin: string;
  /** The driven command argv — placed verbatim after `bin`. */
  argv: string[];
  /** The session workspace root (always --bind RW). */
  workspace: string;
  /** The --chdir target. */
  cwd: string;
  /** `os.homedir()` (injected for testability — the home/credential roots). */
  home: string;
  /** The carve-out target `os.homedir()/.comis` (SEC-13, non-configurable). */
  dataDir: string;
  /** The resolved system RO paths (the caller filters {@link SYSTEM_RO_PATHS} to existing). */
  systemRoPaths: readonly string[];
  /**
   * The worker's `envSnapshot()` output — bwrap forwards this to the child (no
   * --clearenv), so it is scrubbed by {@link scrubChildEnv} and becomes the child
   * env. Passed in (not read here) so the plan stays a pure transform.
   */
  env: NodeJS.ProcessEnv;
}

/** The composed spawn arguments + the egress handle to dispose on teardown. */
export interface SpawnPlan {
  /** arg0 — the bwrap binary. */
  bin: string;
  /** `[...scopeArgs after bwrapPath, [relayArgv], childBin, ...childArgv]`. */
  argv: string[];
  /** The scrubbed (+ proxyEnv for listed-hosts) child env. */
  env: NodeJS.ProcessEnv;
  /**
   * The egress materialization for `network: listed-hosts` — the worker stores it
   * on the session and calls `dispose()` once on teardown (socket cleanup). Absent
   * for `none`/`full`.
   */
  egress?: EgressMaterialization;
}

/** Raised when the jail cannot be materialized (no provider) — SEC-16 fail-closed. */
export class JailUnavailableError extends Error {
  readonly errorKind = "dependency" as const;
  constructor() {
    super("no sandbox provider: cannot materialize the terminal scope jail");
    this.name = "JailUnavailableError";
  }
}

/**
 * Compose the bwrap-wrapping spawn for one session.
 *
 * For `network: listed-hosts` this AWAITS `egressControl.materialize(hosts)` (the
 * only async step) and threads the socket + relay wrapper + proxy env through the
 * composer. For `none`/`full` the egress port is never touched.
 *
 * @throws JailUnavailableError when `bwrapPath` is undefined (SEC-16 — never an
 * unjailed fallback) or when `network: listed-hosts` has no injected egress port.
 */
export async function buildSpawnPlan(
  input: SpawnPlanInput,
  composers: SpawnPlanComposers,
): Promise<SpawnPlan> {
  // SEC-16: no provider => no jail => no spawn. Reject BEFORE any materialization.
  if (composers.bwrapPath === undefined) {
    throw new JailUnavailableError();
  }
  const buildScopeArgs = composers.buildScopeArgs ?? defaultBuildScopeArgs;
  const scrubChildEnv = composers.scrubChildEnv ?? defaultScrubChildEnv;
  const buildEgressRelayLaunch =
    composers.buildEgressRelayLaunch ?? defaultBuildEgressRelayLaunch;

  const { scope } = input;
  const dedicatedUid = scope.uid === "dedicated" ? DEDICATED_UID : undefined;

  // listed-hosts: stand up the egress relay + bind its socket + add the proxy env.
  let egress: EgressMaterialization | undefined;
  let relay: EgressRelayLaunch | undefined;
  let relaySocketPath: string | undefined;
  if (scope.network === "listed-hosts") {
    if (composers.egressControl === undefined) {
      // listed-hosts demands an egress port; absent ⇒ fail-closed (no open net).
      throw new JailUnavailableError();
    }
    egress = await composers.egressControl.materialize(scope.hosts ?? []);
    relaySocketPath = egress.socketPath;
    relay = buildEgressRelayLaunch({
      socketPath: egress.socketPath,
      relayPort: RELAY_LOOPBACK_PORT,
      // The relay-init owns the uid drop for listed-hosts (it must run as
      // userns-root to bring `lo` up first), so hand it the net-new uid.
      dedicatedUid,
    });
  }

  // For listed-hosts the relay-init (above) performs the uid drop AFTER bringing
  // `lo` up as userns-root, so the bwrap jail itself must NOT pre-drop via `--uid`
  // (that would strip CAP_NET_ADMIN and break the loopback-up). For every other
  // network mode bwrap drops the uid directly (no relay in the path).
  const bwrapUid = scope.network === "listed-hosts" ? undefined : dedicatedUid;

  const scopeArgs = buildScopeArgs({
    scope,
    bwrapPath: composers.bwrapPath,
    workspace: input.workspace,
    cwd: input.cwd,
    home: input.home,
    dataDir: input.dataDir,
    systemRoPaths: input.systemRoPaths,
    dedicatedUid: bwrapUid,
    relaySocketPath,
    // listed-hosts: the relay-init runs INSIDE the jail, so its script must be
    // --ro-bound in (node can't load a host path that isn't bound) — SEC-07.
    relayInitScriptPath: relay?.relayInitScriptPath,
  });

  // scopeArgs = [bwrapPath, ...args, "--"]. The child (and, for listed-hosts, the
  // relay-as-init wrapper) go AFTER that `--`.
  const afterSeparator: string[] = [
    ...scopeArgs.slice(1),
    ...(relay?.relayArgv ?? []),
    input.bin,
    ...input.argv,
  ];

  // bwrap forwards the spawner env to the child (no --clearenv): scrub it, then for
  // listed-hosts merge the relay's HTTPS_PROXY/HTTP_PROXY over the scrubbed env.
  const env: NodeJS.ProcessEnv = {
    ...scrubChildEnv(input.env),
    ...(relay?.proxyEnv ?? {}),
  };

  return {
    bin: scopeArgs[0],
    argv: afterSeparator,
    env,
    egress,
  };
}

/** The create-frame fields {@link planSpawnFromCreateFrame} reads (122-01 thread). */
export interface CreateFrameSpawnParams {
  /** The driven command (daemon-canonical, M-1). */
  bin: string;
  /** The driven command argv. */
  argv: string[];
  /** The operator scope; least-privilege default when absent. */
  scope?: TerminalScope;
  /** The session workspace root (always --bind RW). */
  workspace?: string;
  /** The --chdir target. */
  cwd?: string;
}

/**
 * Resolve the host-side jail companions (home, the `~/.comis` carve-out dataDir,
 * the existing system RO paths) and {@link buildSpawnPlan} for a create frame —
 * the single seam the worker calls so `terminal-worker-entry.ts` stays a thin
 * backend-wiring file (<=800). Reads `os.homedir()` + filters {@link SYSTEM_RO_PATHS}
 * by `existsSync` HERE (the worker stays free of those fs/os reads). `env` is the
 * worker's `envSnapshot()` (passed in — bwrap forwards it to the child).
 *
 * @throws JailUnavailableError (via {@link buildSpawnPlan}) on the fail-closed path.
 */
export async function planSpawnFromCreateFrame(
  params: CreateFrameSpawnParams,
  env: NodeJS.ProcessEnv,
  composers: SpawnPlanComposers,
): Promise<SpawnPlan> {
  const home = homedir();
  const scope = params.scope ?? LEAST_PRIVILEGE_SCOPE;
  const workspace = params.workspace ?? home;
  return buildSpawnPlan(
    {
      scope,
      bin: params.bin,
      argv: params.argv,
      workspace,
      cwd: params.cwd ?? workspace,
      home,
      dataDir: safePath(home, ".comis"),
      systemRoPaths: SYSTEM_RO_PATHS.filter((sp) => existsSync(sp)),
      env,
    },
    composers,
  );
}

export { SYSTEM_RO_PATHS };
