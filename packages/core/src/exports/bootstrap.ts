// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Bootstrap (composition root, context, environment loading)

// Environment loading (startup guard for SecretManager)
export { loadEnvFile, assertEnvLoaded, resetEnvLoadedForTest } from "../load-env.js";

// Request context (AsyncLocalStorage-based tenant/user/trace propagation)
export {
  RequestContextSchema,
  UserTrustLevelSchema,
  createResolvedRequestContext,
  enrichCurrentContext,
  getContext,
  tryGetContext,
  runWithContext,
} from "../context/index.js";

export type {
  RequestContext,
  ResolvedRequestContextSeed,
  UserTrustLevel,
} from "../context/index.js";

// Bootstrap (composition root)
export {
  bootstrap,
  INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME,
  resolveConfigRuntimePaths,
} from "../bootstrap.js";
export type { BootstrapOptions, AppContainer } from "../bootstrap.js";
