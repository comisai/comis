// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth adapter sub-package. External consumers import via the
 * @comis/core barrel.
 *
 * Includes the three CLI-facing public symbols (selectOAuthCredentialStore,
 * loginOpenAICodexOAuth, OAuthError) plus the sibling-dep helpers
 * (createOAuthCredentialStoreFile, loginOpenAICodexDeviceCode) that the
 * selector and login runner transitively need.
 *
 * @module
 */

// CLI-facing surface
export { selectOAuthCredentialStore } from "./oauth-credential-store-selector.js";
export type {
  SelectOAuthCredentialStoreInput,
  CredentialStorageMode,
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

// Sibling-dep helpers — co-located with the primary 3 so the selector +
// login runner resolve to in-package siblings (no @comis/agent imports
// allowed from core/src/oauth).
export { createOAuthCredentialStoreFile } from "./oauth-credential-store-file.js";
export type { OAuthCredentialStoreFileConfig } from "./oauth-credential-store-file.js";

export { loginOpenAICodexDeviceCode } from "./oauth-device-code.js";
export type {
  DeviceCodeVerificationPrompt,
  LoginOpenAICodexDeviceCodeOptions,
} from "./oauth-device-code.js";

// The CLI doctor's oauth-health check imports runOAuthTlsPreflight; this
// symbol lives in core so packages/cli/src/ has zero @comis/agent imports.
// Pure function — imports nothing itself.
export { runOAuthTlsPreflight } from "./oauth-tls-preflight.js";
export type {
  TlsPreflightResult,
  TlsPreflightFailureKind,
  TlsCertificateErrorCode,
  TlsPreflightNetworkReason,
  RunOAuthTlsPreflightOptions,
} from "./oauth-tls-preflight.js";
