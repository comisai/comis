// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Security utilities

export { safePath, PathTraversalError } from "../security/index.js";
// Loopback bind detection — shared by the gateway boot log + fleet config-posture.
export { isLoopbackHost } from "../security/index.js";
// Bind-mount validator — consumed by the bwrap sandbox provider.
export { validateBindMount } from "../security/index.js";
// Master-key file helpers (daemon-free `secrets init` body)
export { writeMasterKeyIfAbsent, generateMasterKey } from "../security/index.js";
export type { MasterKeyWriteResult } from "../security/index.js";
export { createSecretManager, createSecretManagerWithMutableHandle, envSubset } from "../security/index.js";
export type { SecretManager, MutableSecretManager } from "../security/index.js";
export { classifyAction, requiresConfirmation } from "../security/index.js";
export type { ActionClassification } from "../security/index.js";
export { AuditEventSchema, createAuditEvent, AUDIT_KINDS, kindIsSecuritySignal } from "../security/index.js";
export type { AuditEvent, AuditKind, CreateAuditEventParams } from "../security/index.js";
// Agent orchestration capabilities + the mint-attenuation trust boundary
// (attenuateCaps — consumed by the broker lease mint).
export { AGENT_CAPABILITIES, checkCapability, requireCapability, CapabilityDeniedError, attenuateCaps } from "../security/index.js";
export type { AgentCapability } from "../security/index.js";
// HANDLER_CAPABILITY_MAP — the single auditable method→capability source-of-truth
export { HANDLER_CAPABILITY_MAP } from "../security/index.js";
export type { HandlerCapabilityClassification, GatedMethodName } from "../security/index.js";
// SELF_SCOPED_AGENT_READS — the tight cap-socket audience exception, surfaced
// on the @comis/core barrel for the @comis/infra lease audience.
export { SELF_SCOPED_AGENT_READS } from "../security/index.js";
export type { SelfScopedAgentRead } from "../security/index.js";
// CLI_SUBCOMMAND_MAP — the comis-agent subcommand→{tool|method} 1:1 table,
// surfaced on the @comis/core barrel for the @comis/skills comis-agent-cli
// dispatch and the same-gate arch-test.
export { CLI_SUBCOMMAND_MAP } from "../security/index.js";
export type { CliCallTarget, CliSubcommand } from "../security/index.js";
// TOOL_CAPABILITY_MAP / TOOL_ROUTE_MAP + ResultRef — the tool.invoke surface
// single-source + the minimal result-handle, surfaced on the @comis/core
// barrel for the daemon gate, the lease audience and the comis_tools SDK
// codegen.
export { TOOL_CAPABILITY_MAP, TOOL_ROUTE_MAP } from "../security/index.js";
export type { ToolName, ToolRoute } from "../security/index.js";
export {
  RESULT_REF_THRESHOLDS,
  DEFAULT_INLINE_THRESHOLD_BYTES,
  PER_FILE_CAP_BYTES,
  PER_RUN_AGGREGATE_CAP_BYTES,
  getResultRefThreshold,
  shouldMaterialize,
  isExpired,
  selectEvictions,
  checkPerFileCap,
  computeExpiresAt,
} from "../security/index.js";
export type { ResultRef } from "../security/index.js";
export { sanitizeLogString, redactErrorMessage } from "../security/index.js";
// Bounded redaction primitive (security/redact-value.ts) — surfaced on the
// @comis/core barrel for the template engine and emit sites.
export { redactValue, REDACT_LIMITS } from "../security/index.js";
export type {
  RedactedValue,
  RedactionReason,
  RedactionRecord,
  RedactOptions,
  RedactLimits,
} from "../security/index.js";
export { validateUrl, validateLocalServerUrl, BLOCKED_RANGES, CLOUD_METADATA_IPS, setSsrfBlockHook } from "../security/index.js";
export type { SsrfBlockReason } from "../security/index.js";
export type { ValidatedUrl } from "../security/index.js";
export { wrapExternalContent, wrapWebContent, detectSuspiciousPatterns, EXTERNAL_CONTENT_WARNING } from "../security/index.js";
export type { ExternalContentSource, WrapExternalContentOptions } from "../security/index.js";
export { createOutputGuard } from "../security/index.js";
export { generateCanaryToken, detectCanaryLeakage } from "../security/index.js";
// Signed interactive-approval callback primitive — channels
// MAY import this; the orchestrator's InteractiveCallbackRouter delegates here.
export {
  signCallbackData,
  verifyCallbackData,
  renderCallbackData,
  parseCallbackData,
} from "../security/index.js";
export type { CallbackChoice, CallbackRenderError, ParsedCallback } from "../security/index.js";
export { createSecretsCrypto, parseMasterKey } from "../security/index.js";
export type { SecretsCrypto, EncryptedSecret } from "../security/index.js";
export { matchesSecretPattern, isSecretAccessible } from "../security/index.js";
export { createScopedSecretManager } from "../security/index.js";
export type { ScopedSecretManagerOptions } from "../security/index.js";
export { generateStrongToken, generateRotationId } from "../security/index.js";
export { looksLikeSecretValue, isSecretFieldName, isEnvRefString, scanForSecrets, redactForDisplay } from "../security/index.js";
export type { SecretFinding } from "../security/index.js";
export { classifyHeaderCredential } from "../security/index.js";
export type { CredentialKind, HeaderCredentialClassification } from "../security/index.js";
export { createAuditAggregator } from "../security/index.js";
export type { AuditAggregator, AuditAggregatorOptions, SecurityEventPayload } from "../security/index.js";
export { validateInput } from "../security/index.js";
export type { InputValidationResult } from "../security/index.js";
export { createInputSecurityGuard } from "../security/index.js";
export type { InputSecurityGuard, InputSecurityGuardResult, InputSecurityGuardConfig } from "../security/index.js";
export { validateMemoryWrite } from "../security/index.js";
export type { MemoryWriteValidationResult } from "../security/index.js";
// Learned-doc static scan — surfaced on the public @comis/core barrel so the
// agent reflection job and the daemon reflect path consume it directly (the
// static scan is ALL the validation an advisory doc gets).
export { validateLearnedDocBody, MAX_DOC_NAME_LENGTH } from "../security/index.js";
export type { LearnedDocValidation, LearnedDocFinding } from "../security/index.js";
export { createInjectionRateLimiter } from "../security/index.js";
export type { InjectionRateLimiter, InjectionRateLimiterConfig, RateLimitResult } from "../security/index.js";
export { resolveSecretRef, resolveConfigSecretRefs } from "../security/index.js";
export type { ResolveSecretRefDeps, ResolveSecretRefOptions } from "../security/index.js";
export { scanConfigForSecrets, scanEnvForSecrets, auditSecrets } from "../security/index.js";
export type { AuditFinding, AuditSeverity, AuditOptions } from "../security/index.js";
// Secret egress guard — shared text scrubber (wiring sites: write-tool, edit-tool, result-condenser, sub-agent-result-processor)
export { scrubSecretsFromText } from "../security/index.js";
export {
  ZERO_WIDTH_REGEX,
  TAG_BLOCK_REGEX,
  stripInvisible,
  containsTagBlockChars,
  // Jailbreak patterns
  IGNORE_PREV_INSTRUCTIONS,
  YOU_ARE_NOW,
  FORGET_EVERYTHING,
  NEW_INSTRUCTIONS,
  IMPORTANT_OVERRIDE,
  IGNORE_INSTRUCTIONS_BROAD,
  DISREGARD_PREVIOUS,
  FORGET_INSTRUCTIONS_BROAD,
  YOU_ARE_NOW_ARTICLE,
  NEW_INSTRUCTIONS_COLON,
  // Expanded jailbreak patterns
  DISREGARD_INSTRUCTIONS,
  ACT_AS_ROLE,
  ASSISTANT_ROLE_MARKER,
  SPECIAL_TOKEN_DELIMITERS,
  CONTEXT_RESET,
  RULE_REPLACEMENT,
  OVERRIDE_SAFETY,
  // Role/XML marker patterns
  SYSTEM_COLON,
  SYSTEM_BRACKET,
  INST_BRACKET,
  SYSTEM_TAG,
  SYSTEM_COMMAND,
  ROLE_BOUNDARY,
  // Dangerous command patterns
  EXEC_COMMAND,
  ELEVATED_TRUE,
  RM_RF,
  DELETE_ALL,
  DANGEROUS_COMMAND_PATTERNS,
  // Secret format patterns
  HEX_SECRET_32,
  BASE64_SECRET,
  PRIVATE_KEY_HEADER,
  GITHUB_TOKEN,
  SLACK_TOKEN,
  // Prompt extraction patterns
  SYSTEM_PROMPT_LABEL,
  INSTRUCTIONS_LABEL,
  PROMPT_EXTRACTION_PATTERNS,
  // Credential log patterns
  SK_API_KEY,
  BEARER_TOKEN_LOG,
  TELEGRAM_BOT_TOKEN,
  GOOGLE_API_KEY,
  JWT_PATTERN,
  URL_PASSWORD,
  // Content scanner patterns
  EXEC_SUBSHELL_PATTERN,
  EXEC_BACKTICK_PATTERN,
  EXEC_EVAL_PATTERN,
  EXEC_PIPE_BASH_PATTERN,
  ENV_PRINTENV_PATTERN,
  ENV_PROC_ENVIRON_PATTERN,
  ENV_MASS_DUMP_PATTERN,
  CRYPTO_STRATUM_PATTERN,
  CRYPTO_MINER_BINARY_PATTERN,
  CRYPTO_POOL_DOMAIN_PATTERN,
  NET_CURL_PIPE_PATTERN,
  NET_WGET_EXEC_PATTERN,
  NET_REVERSE_SHELL_PATTERN,
  OBF_BASE64_LONG_PATTERN,
  OBF_HEX_LONG_PATTERN,
  OBF_BASE64_DECODE_PIPE_PATTERN,
  // XML breakout patterns
  XML_SKILL_CLOSE_TAG,
  XML_SYSTEM_TAG,
  // Workspace scanner patterns
  HTML_COMMENT_INJECTION,
  HIDDEN_DIV_PATTERN,
  TRANSLATE_EXECUTE_PATTERN,
  EXFIL_CURL_PATTERN,
  READ_SECRETS_PATTERN,
  WORKSPACE_SCANNER_PATTERNS,
} from "../security/index.js";
export type { StripResult } from "../security/index.js";

// OAuth helpers
export {
  decodeCodexJwtPayload,
  resolveCodexAuthIdentity,
  resolveCodexStableSubject,
  resolveCodexAccessTokenExpiry,
  redactEmailForLog,
  rewriteOAuthError,
} from "../security/index.js";
export type { OAuthErrorCode, RewrittenOAuthError } from "../security/index.js";

// Provider-catalog: types and pure functions for the MITM broker.
// RequestFinalizer exported here so @comis/infra finalizer-stage.ts can consume it.
export type { BrokerBinding, InjectionRule, HostRule, InjectionInput, RequestFinalizer } from "../security/index.js";
export { resolveBinding, applyInjections, normalizeHost, pathAllowed } from "../security/index.js";
