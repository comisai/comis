// SPDX-License-Identifier: Apache-2.0
// @comis/infra — net/ barrel: the undici-bound runtime pieces of the egress
// proxy. The pure, dependency-free primitives (sanitizeProxyUrl, matchesNoProxy,
// resolveEnvHttpProxyAgentOptions, resolveEffectiveNoProxy, isSsrfBlocked,
// ProxyConfigError, ProxyBootConfig) live in @comis/core/net — import them there.

// Global undici dispatcher installer + test-isolation hook.
export { installGlobalProxyDispatcher, resetProxyDispatcherForTests } from "./proxy-dispatcher.js";

// Shared proxy-agent helper family — SSRF-gated, NO_PROXY-aware, zero-config-safe.
export { resolveHttpsProxyAgent, resolveUndiciProxyAgent, resolveProxyUrl } from "./proxy-agent.js";
export type { ProxyAgentOptions } from "./proxy-agent.js";
