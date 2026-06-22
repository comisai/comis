// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — PURE proxy net primitives (global egress proxy).
//
// They live in @comis/core so the offline `comis proxy validate` CLI command
// can consume them without a cli→infra import (L12 architecture invariant). The
// undici-bound runtime pieces (dispatcher installer, ssrfBlockInterceptor, agent
// helpers) live in @comis/infra.

export {
  sanitizeProxyUrl,
  matchesNoProxy,
  resolveEnvHttpProxyAgentOptions,
  resolveEffectiveNoProxy,
  isSsrfBlocked,
  ProxyConfigError,
} from "../net/index.js";
export type { ProxyBootConfig } from "../net/index.js";
