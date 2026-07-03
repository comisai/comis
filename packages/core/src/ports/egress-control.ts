// SPDX-License-Identifier: Apache-2.0
/**
 * EgressControlPort: the SEGREGATED hexagonal boundary for the terminal driver's
 * `network: listed-hosts` egress filter. It materializes a
 * **no-secret host-allowlist CONNECT proxy** bound to the entry's `scope.hosts[]`
 * and returns a unix socket to bind-mount into the jail. The transport is
 * proven end-to-end (allowlisted host -> 200, non-listed
 * -> 403, direct `--unshare-net` bypass -> rc=7, no route): a host-side allowlist
 * proxy on a unix socket, bridged into the jail by an in-jail loopback relay
 * exposed to the driven CLI as `HTTPS_PROXY=http://127.0.0.1:<port>`.
 *
 * This is DISTINCT from the credential broker (an optional tier). The
 * broker injects an Authorization header to mint scoped credentials; this port
 * injects NOTHING into the stream — it is a pure CONNECT relay whose only job is
 * to gate the destination host against the operator allowlist. The two never
 * share an implementation; conflating them is a security regression (a credential
 * leak), so this port carries no secret material by construction.
 *
 * Placement (binding constraint): the PORT TYPE lives here in
 * @comis/core; the worker-side relay launcher (@comis/skills) imports ONLY this
 * type and NEVER value-imports @comis/infra (the architecture test names the
 * relay file as infra-free). The concrete proxy (a Node `net` server, no infra)
 * is constructed by the daemon — the composition root — and injected via this
 * port. The dispositions across the three `network` modes:
 *
 *   - `none`         -> deny-all. {@link EgressControlPort.materialize} is NEVER
 *                       called; the jail runs under `--unshare-net` with no socket.
 *   - `listed-hosts` -> materialize the allowlist proxy; bind-mount the returned
 *                       `socketPath`; the in-jail relay bridges to it.
 *   - `full`         -> the caller uses `--share-net`; this port is not involved.
 *
 * This file is type-only (mirrors triple-store.ts / secret-store.ts): no runtime
 * value export, no zod, no @comis/infra import. A `class`/`function` value export
 * here would be a layering smell — the implementation belongs in the daemon.
 *
 * @module
 */

/**
 * The result of standing up the host-side allowlist proxy for one
 * `listed-hosts` session: the unix socket to bind-mount into the jail, plus a
 * teardown handle. The `socketPath` is exactly the value the scope->argv composer
 * (`buildScopeArgs`) binds via its `relaySocketPath` input
 * (`--bind <socketPath> <socketPath>`), so the bind-mount and the proxy listen on
 * the same path.
 */
export interface EgressMaterialization {
  /**
   * The host unix socket the allowlist proxy listens on, to bind-mount into the
   * jail. A transient per-session path under a temp dir (e.g.
   * `<tmp>/comis-egress-<id>.sock`) — NOT OS-persistent state; {@link dispose}
   * unlinks it.
   */
  socketPath: string;
  /**
   * Tear down the materialized egress: close the proxy server and unlink the
   * socket file. Called at session teardown by the registry that owns the
   * session lifetime. Idempotent — a second call after the socket is already
   * gone must resolve, not throw.
   */
  dispose(): Promise<void>;
}

export interface EgressControlPort {
  /**
   * Stand up a no-secret host-allowlist CONNECT proxy bound to `hosts` and return
   * the unix socket to bind-mount into the jail. Called ONLY for
   * `network: listed-hosts`. The proxy `CONNECT`s only to a host in `hosts`
   * (exact host match); every other target is refused with a 403-class response
   * and no upstream dial. It injects nothing into the stream (no-secret — it is
   * not the credential broker).
   *
   * For `network: none` the caller never invokes this (deny-all). For
   * `network: full` the caller uses `--share-net` and does not involve this port.
   */
  materialize(hosts: string[]): Promise<EgressMaterialization>;
}
