// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth helper re-exports for the @comis/core barrel.
 *
 * CLI consumers import these names from @comis/core (no longer from
 * @comis/agent; the agent-side re-exports have been removed).
 *
 * @module
 */

export {
  selectOAuthCredentialStore,
  loginOpenAICodexOAuth,
  createOAuthCredentialStoreFile,
  loginOpenAICodexDeviceCode,
  runOAuthTlsPreflight,
} from "../oauth/index.js";

export type {
  SelectOAuthCredentialStoreInput,
  OAuthStorageMode,
  LoginError,
  LoginRunnerSuccess,
  LoginRunnerParams,
  RunnerPrompter,
  OAuthError,
  OAuthTokenManager,
  OAuthTokenManagerDeps,
  OAuthCredentials,
  OAuthCredentialStoreFileConfig,
  DeviceCodeVerificationPrompt,
  LoginOpenAICodexDeviceCodeOptions,
  TlsPreflightResult,
  TlsPreflightFailureKind,
  RunOAuthTlsPreflightOptions,
} from "../oauth/index.js";
