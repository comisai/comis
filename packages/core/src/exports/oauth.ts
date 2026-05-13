// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth helper re-exports for the @comis/core barrel.
 *
 * Added in Phase 35 Plan 35-03 per WEB-CONTRACTS-02 D-01 #2. Plan 35-05
 * retargets CLI consumers from @comis/agent to @comis/core via these names;
 * Plan 35-04 deletes the agent-side re-exports after the retarget lands.
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
