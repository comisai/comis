// SPDX-License-Identifier: Apache-2.0
/**
 * buildEgressRelayLaunch -- the worker-side, PORT-typed constructor for the
 * in-jail relay-as-init launch (SEC-07, §3.5). It builds (does NOT run) the pieces
 * the Terminal Worker (122-06) needs to spawn the driven CLI under the egress
 * relay for `network: listed-hosts`:
 *
 *   1. `relayArgv` — the relay-as-init wrapper that runs INSIDE the jail as the
 *      userns-root init and, in this exact order (118 §3 "Composition note",
 *      RESEARCH Pitfall 3 / Open Q2 = relay-as-init):
 *        a. brings `lo` up (needs CAP_NET_ADMIN, held over the OWNED netns),
 *        b. launches a TCP->unix relay on `127.0.0.1:<relayPort>` forwarding every
 *           connection to the bind-mounted host unix socket (`socketPath`),
 *        c. DROPS to the net-new uid (privilege-drop BEFORE exec — the child must
 *           never run with the cap held),
 *        d. execs the driven child, which sees the relay via `HTTPS_PROXY`.
 *   2. `proxyEnv` — the env addition pointing the child's standard TCP-proxy
 *      client (curl / node-undici / claude) at the in-jail relay:
 *      `HTTPS_PROXY=HTTP_PROXY=http://127.0.0.1:<relayPort>`. No client needs
 *      native proxy-over-unix support; the relay bridges TCP->unix (118 resolved
 *      "HTTPS_PROXY-TCP vs unix-socket: use BOTH, bridged by the relay").
 *   3. `socketPath` — echoed back so the caller feeds it to `buildScopeArgs`'
 *      `relaySocketPath` (122-03) for the `--bind <socketPath> <socketPath>`
 *      bind-mount; the proxy listens on, and the relay bridges to, the SAME path.
 *
 * This is a PURE function (no spawn, no netns, no fs) — so the construction is
 * fully macOS-testable. The LIVE relay-as-init (the real `lo`-up + bridge +
 * uid-drop + exec inside `--unshare-net`) is NOT macOS-testable; its enforcement
 * is the VPS security suite (122-07) + the live `bwrap-egress-integration.test.ts`.
 *
 * BINDING CONSTRAINT (122-RESEARCH): this worker-side module imports the
 * {@link EgressControlPort} as a TYPE from @comis/core and NEVER value-imports
 * @comis/infra (the architecture test names this file; a focused source grep in
 * the neighbor test is the second guard). The concrete proxy (the port impl) is
 * wired by the daemon and injected — the worker only depends on the port type.
 *
 * @module
 */

import type { EgressControlPort } from "@comis/core";

/**
 * The in-jail init binary that performs the relay-as-init sequence. It runs as the
 * jail's PID-1 / userns-root, so it must resolve to a path bound INTO the jail
 * (the `/usr` ro-bind). The worker (122-06) supplies/builds the actual init
 * program (a small node or shell shim) + the dedicated uid; this builder names the
 * contract the worker invokes. Kept as a sentinel constant so the worker and this
 * builder agree on the wrapper's entry point.
 */
export const RELAY_INIT_BIN = "comis-egress-relay-init" as const;

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
}

/**
 * Build the relay-as-init launch pieces for one `listed-hosts` session. Pure: no
 * spawn, no netns, no fs — the worker (122-06) executes the result; this only
 * constructs it (macOS-testable). See the module doc for the relay-as-init order.
 */
export function buildEgressRelayLaunch(input: EgressRelayLaunchInput): EgressRelayLaunch {
  const proxyUrl = `http://127.0.0.1:${input.relayPort}`;
  return {
    // The wrapper carries the two coordinates it bridges between: the loopback
    // port (where the child's HTTPS_PROXY points) and the bind-mounted unix socket
    // (where the host allowlist proxy listens). The trailing `--` separates the
    // wrapper's own flags from the child argv the worker appends.
    relayArgv: [
      RELAY_INIT_BIN,
      "--socket",
      input.socketPath,
      "--port",
      String(input.relayPort),
      "--",
    ],
    proxyEnv: {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
    },
    socketPath: input.socketPath,
  };
}

/**
 * Type-only re-export of the port the worker depends on (the value impl is
 * daemon-wired + injected). Re-exporting the TYPE here keeps the binding
 * constraint legible at the worker-side call site: the relay launcher and the
 * worker speak {@link EgressControlPort}, never @comis/infra.
 */
export type { EgressControlPort };
