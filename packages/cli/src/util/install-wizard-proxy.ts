// SPDX-License-Identifier: Apache-2.0
/**
 * Env-only proxy dispatcher install for the `comis init` wizard.
 *
 * The wizard's live credential/channel validation uses global `fetch` (undici),
 * which ignores HTTP(S)_PROXY unless a dispatcher is installed. This installs an
 * EnvHttpProxyAgent so wizard validation honours the operator's proxy env.
 *
 * Best-effort: no config.yaml exists yet at init time, so a malformed proxy env
 * must never crash the wizard. Loopback/gateway addresses are kept OUT of the
 * proxy (NO_PROXY) so the post-setup daemon health check on localhost:4766 is
 * not misrouted.
 *
 * Lives in @comis/cli (not @comis/infra) so the CLI does not import @comis/infra
 * (architecture invariant L12). It uses undici directly — a cli dependency, the
 * pattern documented in doctor/checks/oauth-health.ts — with the pure NO_PROXY /
 * env resolution from @comis/core. The daemon installs the full SSRF-guarded
 * dispatcher at boot (installGlobalProxyDispatcher); this lighter wizard install
 * targets only fixed, well-known provider/channel API hosts.
 *
 * @module
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import {
  resolveEnvHttpProxyAgentOptions,
  resolveEffectiveNoProxy,
} from "@comis/core";

/**
 * Install a global undici dispatcher from the proxy environment variables.
 *
 * @returns `true` if a dispatcher was installed (proxy env present), `false`
 *   when no proxy env is set or the install failed (best-effort, never throws).
 */
export function installWizardProxyFromEnv(
  env: Record<string, string | undefined>,
): boolean {
  try {
    // No proxy env → leave global fetch untouched (byte-identical default path).
    if (resolveEnvHttpProxyAgentOptions(env) === undefined) {
      return false;
    }
    const noProxy = resolveEffectiveNoProxy({
      env,
      loopbackMode: "gateway-only",
    } as Parameters<typeof resolveEffectiveNoProxy>[0]);
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: env["HTTP_PROXY"] ?? env["http_proxy"],
        httpsProxy: env["HTTPS_PROXY"] ?? env["https_proxy"],
        noProxy,
        allowH2: false,
      }),
    );
    return true;
  } catch {
    // Best-effort: a bad proxy env must not crash the wizard.
    return false;
  }
}
