// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth adapter sub-package — relocated from @comis/agent in Phase 35
 * (D-01 #2). External consumers import via the @comis/core barrel.
 *
 * Includes the three CLI-facing public symbols (selectOAuthCredentialStore,
 * loginOpenAICodexOAuth, OAuthError) plus the sibling-dep helpers
 * (createOAuthCredentialStoreFile, loginOpenAICodexDeviceCode) that the
 * relocated files transitively need. Plan 35-05 retargets CLI consumers
 * from @comis/agent to @comis/core via pure import-path swaps; Plan 35-04
 * then deletes the agent re-exports.
 *
 * @module
 */

// CLI-facing surface (Plan 35-05 retargets these import paths)
export { selectOAuthCredentialStore } from "./oauth-credential-store-selector.js";
export type {
  SelectOAuthCredentialStoreInput,
  OAuthStorageMode,
} from "./oauth-credential-store-selector.js";

export { loginOpenAICodexOAuth } from "./oauth-login-runner.js";
export type {
  LoginError,
  LoginRunnerSuccess,
  LoginRunnerParams,
  RunnerPrompter,
} from "./oauth-login-runner.js";

export type {
  OAuthError,
  OAuthTokenManager,
  OAuthTokenManagerDeps,
  OAuthCredentials,
} from "./oauth-token-manager.js";

// Sibling-dep helpers — relocated alongside the primary 3 so the selector +
// login runner resolve to in-package siblings (acceptance criteria forbids
// any import statements that target @comis-slash-agent in core/src/oauth).
export { createOAuthCredentialStoreFile } from "./oauth-credential-store-file.js";
export type { OAuthCredentialStoreFileConfig } from "./oauth-credential-store-file.js";

export { loginOpenAICodexDeviceCode } from "./oauth-device-code.js";
export type {
  DeviceCodeVerificationPrompt,
  LoginOpenAICodexDeviceCodeOptions,
} from "./oauth-device-code.js";

// Phase 35 Plan 35-04 (drift recovery): the CLI doctor's oauth-health check
// imports runOAuthTlsPreflight, and the plan's truth #11 ("After this plan:
// zero `from \"@comis/agent\"` imports anywhere in packages/cli/src/") requires
// this last symbol to live in core too. Pure-function relocation — no imports.
export { runOAuthTlsPreflight } from "./oauth-tls-preflight.js";
export type {
  TlsPreflightResult,
  TlsPreflightFailureKind,
  RunOAuthTlsPreflightOptions,
} from "./oauth-tls-preflight.js";
