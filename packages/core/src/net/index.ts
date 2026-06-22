// SPDX-License-Identifier: Apache-2.0
// @comis/core — net/ barrel (PURE proxy net primitives).
//
// These are the dependency-free primitives shared by the runtime egress-proxy
// dispatcher (@comis/infra) and the offline `comis proxy validate` command
// (@comis/cli). They live in @comis/core so @comis/cli can consume them WITHOUT
// a cli→infra import (the L12 architecture invariant); the daemon imports them
// from @comis/core too.
//
// The undici-bound runtime pieces (installGlobalProxyDispatcher,
// ssrfBlockInterceptor, resolveHttpsProxyAgent, …) live in @comis/infra and
// import these primitives from here.

// Proxy URL credential sanitizer
export { sanitizeProxyUrl } from "./sanitize.js";

// Env resolution: ALL_PROXY expansion, lowercase-wins, matchesNoProxy
// + effective-NO_PROXY loopback forcing
export {
  matchesNoProxy,
  resolveEnvHttpProxyAgentOptions,
  resolveEffectiveNoProxy,
  resolveEnvHttpProxyUrl,
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  hasProxyEnvConfigured,
  shouldUseEnvHttpProxyForUrl,
  PROXY_ENV_KEYS,
} from "./proxy-env.js";
export type { EnvHttpProxyAgentProxyOptions } from "./proxy-env.js";

// SSRF blocklist predicate + exported CIDR range list
export { isSsrfBlocked, BLOCKED_IPV4_CIDR_RANGES } from "./ssrf.js";

// Structural config type + fail-fast error class
export type { ProxyBootConfig } from "./proxy-config.js";
export { ProxyConfigError } from "./proxy-config.js";
