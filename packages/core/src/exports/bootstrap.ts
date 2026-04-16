// @comis/core exports — Bootstrap (composition root, context, environment loading)

// Environment loading (startup guard for SecretManager)
export { loadEnvFile, assertEnvLoaded, resetEnvLoadedForTest } from "../load-env.js";

// Request context (AsyncLocalStorage-based tenant/user/trace propagation)
export {
  RequestContextSchema,
  UserTrustLevelSchema,
  getContext,
  tryGetContext,
  runWithContext,
} from "../context/index.js";

export type { RequestContext, UserTrustLevel } from "../context/index.js";

// Bootstrap (composition root)
export { bootstrap } from "../bootstrap.js";
export type { BootstrapOptions, AppContainer } from "../bootstrap.js";
