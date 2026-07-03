// SPDX-License-Identifier: Apache-2.0
/**
 * buildEgressRelayLaunch -- the worker-side, PORT-typed constructor for the
 * in-jail relay-as-init launch. It builds (does NOT run) the pieces
 * the Terminal Worker needs to spawn the driven CLI under the egress
 * relay for `network: listed-hosts`:
 *
 *   1. `relayArgv` — the relay-as-init wrapper that runs INSIDE the jail as the
 *      userns-root init and, in this exact order (the relay-as-init composition):
 *        a. brings `lo` up (needs CAP_NET_ADMIN, held over the OWNED netns),
 *        b. launches a TCP->unix relay on `127.0.0.1:<relayPort>` forwarding every
 *           connection to the bind-mounted host unix socket (`socketPath`),
 *        c. DROPS to the net-new uid (privilege-drop BEFORE exec — the child must
 *           never run with the cap held),
 *        d. execs the driven child, which sees the relay via `HTTPS_PROXY`.
 *   2. `proxyEnv` — the env addition pointing the child's standard TCP-proxy
 *      client (curl / node-undici / claude) at the in-jail relay:
 *      `HTTPS_PROXY=HTTP_PROXY=http://127.0.0.1:<relayPort>`. No client needs
 *      native proxy-over-unix support; the relay bridges TCP->unix (both the
 *      TCP-proxy env and the unix socket are used, bridged by the relay).
 *   3. `socketPath` — echoed back so the caller feeds it to `buildScopeArgs`'
 *      `relaySocketPath` for the `--bind <socketPath> <socketPath>`
 *      bind-mount; the proxy listens on, and the relay bridges to, the SAME path.
 *
 * This is a PURE function (no spawn, no netns, no fs) — so the construction is
 * fully macOS-testable. The LIVE relay-as-init (the real `lo`-up + bridge +
 * uid-drop + exec inside `--unshare-net`) is NOT macOS-testable; its enforcement
 * is the VPS security suite + the live `bwrap-egress-integration.test.ts`.
 *
 * BINDING CONSTRAINT: this worker-side module imports the
 * {@link EgressControlPort} as a TYPE from @comis/core and NEVER value-imports
 * @comis/infra (the architecture test names this file; a focused source grep in
 * the neighbor test is the second guard). The concrete proxy (the port impl) is
 * wired by the daemon and injected — the worker only depends on the port type.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EgressControlPort } from "@comis/core";

/**
 * Resolve the on-disk relay-as-init script ({@link ./egress-relay-init.ts},
 * compiled to `egress-relay-init.js` by tsc) to a RUNNABLE `.js` that EXISTS — the
 * launcher runs it as a real subprocess (`process.execPath <this URL>`), and Node
 * cannot exec a `.ts`, so the URL must point at the compiled `.js` in BOTH contexts:
 *
 *   - PRODUCTION: the worker runs from `dist/`, so `import.meta.url` is the dist
 *     `terminal-egress-relay.js` and the sibling `egress-relay-init.js` is right
 *     there — the direct sibling resolves and exists.
 *   - VITEST-FROM-SRC: `import.meta.url` is the `.ts` SOURCE, so the direct sibling
 *     would be `src/.../egress-relay-init.js` — which does NOT exist (only the `.ts`
 *     is in `src`). The package is BUILT before tests run, so the compiled `.js`
 *     lives under the parallel `dist/` tree; map the resolved `/src/` path segment to
 *     `/dist/` to reach it.
 *
 * A bare `new URL("./egress-relay-init.js", import.meta.url)` is production-correct
 * but src-test-broken (it pointed at the absent `src` `.js`, and the VPS scope-matrix
 * egress cell died with `Cannot find module`). The existsSync-then-src->dist map below
 * is honest: BOTH branches resolve to the real compiled relay-init.js the launcher
 * actually spawns. This replaced the earlier sentinel name (`comis-egress-relay-init`)
 * which pointed at a binary that was never built — the listed-hosts gap.
 */
function resolveRelayInitScript(): URL {
  // The direct sibling: correct in dist (production) or anywhere the built `.js`
  // sits next to this module's `.js`.
  const direct = new URL("./egress-relay-init.js", import.meta.url);
  if (existsSync(fileURLToPath(direct))) return direct;
  // vitest-from-src: this module is the `src` `.ts`, so the direct sibling `.js` is
  // absent — the compiled `.js` is under the parallel `dist/` tree. Map the FIRST
  // `/src/` path segment to `/dist/` (the dist layout mirrors src 1:1). Use the
  // path separator on both sides so the swap is a whole-segment replace, never a
  // substring hit inside a dir name.
  const distPath = fileURLToPath(direct).replace(`${sep}src${sep}`, `${sep}dist${sep}`);
  return pathToFileURL(distPath);
}

/**
 * The on-disk relay-as-init script the in-jail launch points at — a module-const
 * URL (mirrors the prior export shape; NO module-global mutable state). Resolved
 * ONCE via {@link resolveRelayInitScript} so it is the real compiled `.js` in both
 * production (dist) and vitest-from-src (src->dist-mapped). It is spawned as a
 * subprocess inside the bwrap jail as the userns-root PID-1 init: bring `lo` up ->
 * TCP->unix relay on `127.0.0.1:<port>` -> drop to the net-new uid -> exec the
 * child. Travels with the package (`files: ["dist"]`), works under the `/usr`
 * ro-bind from the daemon install, and needs no separate asset-copy step.
 */
export const RELAY_INIT_SCRIPT_URL = resolveRelayInitScript();

/** Input to {@link buildEgressRelayLaunch}. */
export interface EgressRelayLaunchInput {
  /**
   * The host unix socket bind-mounted into the jail (from
   * {@link EgressControlPort.materialize}). The in-jail relay forwards every
   * `127.0.0.1:<relayPort>` connection to THIS socket. Also fed to
   * `buildScopeArgs`' `relaySocketPath` for the bind-mount.
   */
  socketPath: string;
  /**
   * The loopback TCP port the in-jail relay listens on, exposed to the child as
   * `HTTPS_PROXY=http://127.0.0.1:<relayPort>`. An ephemeral, jail-local port (the
   * netns is isolated — no host collision possible).
   */
  relayPort: number;
  /**
   * The net-new uid/gid the relay-init drops to BEFORE exec'ing the child. For
   * `listed-hosts` the init (not bwrap's `--uid`) owns the uid drop, because it must
   * run as userns-root to bring `lo` up first (the relay-as-init composition). Absent ⇒ no
   * drop (the init exec's the child with whatever uid the jail already holds).
   */
  dedicatedUid?: { uid: number; gid: number };
}

/** The pieces the worker needs to spawn the child under the egress relay. */
export interface EgressRelayLaunch {
  /**
   * The relay-as-init wrapper argv to insert AFTER bwrap's `--` and BEFORE the
   * driven child's `{bin, argv}`: the worker spawns
   * `bwrap [scope-args] -- ...relayArgv bin ...childArgv`. The wrapper brings `lo`
   * up, runs the TCP->unix relay (`--socket <socketPath> --port <relayPort>`),
   * drops to the net-new uid, then execs the trailing child argv.
   */
  relayArgv: string[];
  /**
   * The env addition for the driven child: `HTTPS_PROXY`/`HTTP_PROXY` pointing at
   * the in-jail relay. Merged over the child's scrubbed env snapshot by the worker.
   */
  proxyEnv: Record<string, string>;
  /** Echo of the input socket path — the caller binds it via `relaySocketPath`. */
  socketPath: string;
  /**
   * The resolved on-disk relay-init script the in-jail `node` execs (== `relayArgv[1]`).
   * The caller feeds it to `buildScopeArgs`' `relayInitScriptPath` for the
   * `--ro-bind <path> <path>` so in-jail node can READ its own init script (the file
   * exists on the HOST but is NOT bound by default; the VPS scope-matrix
   * egress cell died with `Cannot find module …/egress-relay-init.js` without it).
   * Returned from the SAME source as `relayArgv[1]` so the bound path and the exec
   * path can never drift.
   */
  relayInitScriptPath: string;
}

/**
 * Build the relay-as-init launch pieces for one `listed-hosts` session. Pure: no
 * spawn, no netns, no fs — the worker executes the result; this only
 * constructs it (macOS-testable). See the module doc for the relay-as-init order.
 */
export function buildEgressRelayLaunch(input: EgressRelayLaunchInput): EgressRelayLaunch {
  const proxyUrl = `http://127.0.0.1:${input.relayPort}`;
  // The runnable in-jail launch: `node <relay-init script> --socket <sock>
  // --port <port> [--setgid <g> --setuid <u>] --`. Run as a subprocess (arg0 =
  // process.execPath) so it works under the jail's `/usr` ro-bind; the trailing
  // `--` separates the init's flags from the child argv the worker appends after.
  // The script path is ALSO surfaced as `relayInitScriptPath` so the caller can
  // `--ro-bind` it (in-jail node must READ this exact file).
  const relayInitScriptPath = fileURLToPath(RELAY_INIT_SCRIPT_URL);
  const relayArgv: string[] = [
    process.execPath,
    relayInitScriptPath,
    "--socket",
    input.socketPath,
    "--port",
    String(input.relayPort),
  ];
  if (input.dedicatedUid !== undefined) {
    // gid before uid so the init can setgid while still root (a uid drop first
    // would forbid the later setgid); the init enforces the same order.
    relayArgv.push("--setgid", String(input.dedicatedUid.gid));
    relayArgv.push("--setuid", String(input.dedicatedUid.uid));
  }
  relayArgv.push("--");
  return {
    relayArgv,
    proxyEnv: {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
    },
    socketPath: input.socketPath,
    relayInitScriptPath,
  };
}

/**
 * Type-only re-export of the port the worker depends on (the value impl is
 * daemon-wired + injected). Re-exporting the TYPE here keeps the binding
 * constraint legible at the worker-side call site: the relay launcher and the
 * worker speak {@link EgressControlPort}, never @comis/infra.
 */
export type { EgressControlPort };
