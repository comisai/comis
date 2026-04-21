// SPDX-License-Identifier: Apache-2.0
/**
 * Content scanner detection patterns.
 *
 * Detects code execution, environment access, cryptocurrency mining,
 * network exfiltration, obfuscation, XML breakout, and workspace
 * injection patterns. Originally from content-scanner.ts.
 *
 * @module content-scanner
 */

/** Subshell command injection: $(command) with dangerous binary */
export const EXEC_SUBSHELL_PATTERN = /\$\([^)]*(?:curl|wget|bash|sh|nc|ncat)\b[^)]*\)/gi;

/** Backtick command injection with dangerous binary (requires command context: args/pipes/paths after binary) */
export const EXEC_BACKTICK_PATTERN = /`[^`]*\b(?:curl|wget|bash|sh|nc|ncat)\b(?:\s+[^`]+)`/gi;

/** eval() with string argument */
export const EXEC_EVAL_PATTERN = /\beval\s*\(\s*["'`]/gi;

/** Pipe to shell interpreter */
export const EXEC_PIPE_BASH_PATTERN = /\|\s*(?:bash|sh|zsh|ksh)\b/gi;

/** printenv command */
export const ENV_PRINTENV_PATTERN = /\bprintenv\b/gi;

/** /proc/self/environ access */
export const ENV_PROC_ENVIRON_PATTERN = /\/proc\/self\/environ/gi;

/** Environment dump piped to exfiltration */
export const ENV_MASS_DUMP_PATTERN = /\benv\s*\|\s*(?:grep|sort|tee|curl|nc|base64)/gi;

/** Mining pool protocol (stratum://) */
export const CRYPTO_STRATUM_PATTERN = /\bstratum\+?(?:tcp|ssl)?:\/\//gi;

/** Known cryptocurrency miner binary */
export const CRYPTO_MINER_BINARY_PATTERN = /\b(?:xmrig|cgminer|bfgminer|ethminer|nbminer|phoenixminer|t-rex)\b/gi;

/** Mining pool domain pattern */
export const CRYPTO_POOL_DOMAIN_PATTERN = /\b(?:mining|pool|hashrate)\.[a-z]{2,}\.[a-z]{2,}/gi;

/** curl output piped to interpreter */
export const NET_CURL_PIPE_PATTERN = /\bcurl\b[^|;]*\|\s*(?:bash|sh|python|perl|ruby)\b/gi;

/** wget output to stdout piped elsewhere */
export const NET_WGET_EXEC_PATTERN = /\bwget\b[^|;]*-O\s*-[^|;]*\|/gi;

/** Reverse shell pattern */
export const NET_REVERSE_SHELL_PATTERN = /\b(?:bash\s+-i|\/dev\/tcp\/|nc\s+-[elp]|ncat\s+-[elp])\b/gi;

/** Long base64-encoded string (80+ chars) */
export const OBF_BASE64_LONG_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/g;

/** Long hex-escaped string (20+ sequences, flattened character class for ReDoS safety) */
export const OBF_HEX_LONG_PATTERN = /\\x[0-9a-fA-F]{2}[\\x0-9a-fA-F]{76,1996}/g;

/** base64 decode piped to another command */
export const OBF_BASE64_DECODE_PIPE_PATTERN = /\bbase64\s+(?:-d|--decode)\s*\|/gi;

// ---------------------------------------------------------------------------
// XML Breakout Patterns
// ---------------------------------------------------------------------------

/** Closing tags for skill XML structure: </available_skills>, </skill_invocation> */
export const XML_SKILL_CLOSE_TAG = /<\/(?:available_skills|skill_invocation)>/gi;

/** System-level message tags: <system>, </system>, <tool_result>, </tool_result>, <function_call>, </function_call> */
export const XML_SYSTEM_TAG = /<\/?\s*(?:system|tool_result|function_call)>/gi;

// ---------------------------------------------------------------------------
// Workspace Scanner Patterns
// ---------------------------------------------------------------------------

/** HTML comments containing injection keywords (ignore, override, system, secret, hidden) */
export const HTML_COMMENT_INJECTION = /<!--[^>]{0,200}(?:ignore|override|system|secret|hidden)[^>]{0,200}-->/gi;

/** CSS display:none divs used to hide injected content */
export const HIDDEN_DIV_PATTERN = /<\s{0,5}div\s+style\s{0,5}=\s{0,5}["'][^"']{0,200}display\s{0,5}:\s{0,5}none/gi;

/** "translate X into Y and execute" social engineering */
export const TRANSLATE_EXECUTE_PATTERN = /translate\s{1,20}.{1,100}\s+into\s{1,20}.{1,50}\s+and\s{1,10}(?:execute|run|eval)/gi;

/** curl commands that interpolate secret-bearing env vars */
export const EXFIL_CURL_PATTERN = /curl\s+[^\n]{0,200}\$\{?\w{0,30}(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/gi;

/** cat of credential files (.env, credentials, .netrc, .pgpass) */
export const READ_SECRETS_PATTERN = /cat\s+[^\n]{0,100}(?:\.env|credentials|\.netrc|\.pgpass)/gi;

/** All workspace scanner patterns. */
export const WORKSPACE_SCANNER_PATTERNS: readonly RegExp[] = [
  HTML_COMMENT_INJECTION,
  HIDDEN_DIV_PATTERN,
  TRANSLATE_EXECUTE_PATTERN,
  EXFIL_CURL_PATTERN,
  READ_SECRETS_PATTERN,
];
