// SPDX-License-Identifier: Apache-2.0
// @comis/core/security — Security utilities

export { safePath, PathTraversalError } from "./safe-path.js";

// SSRF guard
export { validateUrl, BLOCKED_RANGES, CLOUD_METADATA_IPS } from "./ssrf-guard.js";
export type { ValidatedUrl } from "./ssrf-guard.js";
export { createSecretManager, envSubset } from "./secret-manager.js";
export type { SecretManager } from "./secret-manager.js";

// Action classifier
export { classifyAction, requiresConfirmation, registerAction, lockRegistry, isRegistryLocked } from "./action-classifier.js";
export type { ActionClassification } from "./action-classifier.js";

// Audit events
export { AuditEventSchema, createAuditEvent } from "./audit.js";
export type { AuditEvent, CreateAuditEventParams } from "./audit.js";

// Log sanitizer
export { sanitizeLogString } from "./log-sanitizer.js";

// External content security wrapping
export { wrapExternalContent, wrapWebContent, detectSuspiciousPatterns, EXTERNAL_CONTENT_WARNING } from "./external-content.js";
export type { ExternalContentSource, WrapExternalContentOptions } from "./external-content.js";

// Output guard adapter
export { createOutputGuard } from "./output-guard.js";

// Audit event aggregator
export { createAuditAggregator } from "./audit-aggregator.js";
export type { AuditAggregator, AuditAggregatorOptions, SecurityEventPayload } from "./audit-aggregator.js";

// Input validator
export { validateInput } from "./input-validator.js";
export type { InputValidationResult } from "./input-validator.js";

// Input security guard
export { createInputSecurityGuard } from "./input-security-guard.js";
export type { InputSecurityGuard, InputSecurityGuardResult, InputSecurityGuardConfig } from "./input-security-guard.js";

// Memory write validator
export { validateMemoryWrite } from "./memory-write-validator.js";
export type { MemoryWriteValidationResult } from "./memory-write-validator.js";

// Canary tokens
export { generateCanaryToken, detectCanaryLeakage } from "./canary-token.js";

// Secret encryption engine
export { createSecretsCrypto, parseMasterKey } from "./secret-crypto.js";
export type { SecretsCrypto, EncryptedSecret } from "./secret-crypto.js";

// Secret access pattern matching
export { matchesSecretPattern, isSecretAccessible } from "./secret-access.js";

// Scoped secret manager decorator
export { createScopedSecretManager } from "./secret-manager.js";
export type { ScopedSecretManagerOptions } from "./secret-manager.js";

// Strong token generation
export { generateStrongToken, generateRotationId } from "./token-generator.js";

// Config secret redaction
export { redactConfigSecrets } from "./config-redaction.js";

// Injection pattern constants
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
} from "./injection-patterns.js";
export type { StripResult } from "./injection-patterns.js";

// Injection rate limiter
export { createInjectionRateLimiter } from "./injection-rate-limiter.js";
export type { InjectionRateLimiter, InjectionRateLimiterConfig, RateLimitResult } from "./injection-rate-limiter.js";

// SecretRef resolver
export { resolveSecretRef, resolveConfigSecretRefs } from "./secret-ref-resolver.js";
export type { ResolveSecretRefDeps, ResolveSecretRefOptions } from "./secret-ref-resolver.js";

// Config secret redaction pattern (reused by audit scanner)
export { SECRET_FIELD_PATTERN } from "./config-redaction.js";

// Secrets audit scanner
export { scanConfigForSecrets, scanEnvForSecrets, auditSecrets } from "./secrets-audit.js";
export type { AuditFinding, AuditSeverity, AuditOptions } from "./secrets-audit.js";
