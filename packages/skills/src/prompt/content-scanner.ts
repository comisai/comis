/**
 * Content scanner for prompt skill bodies.
 *
 * Inspects sanitized skill body content at load time for dangerous patterns
 * across five categories: exec injection, environment variable harvesting,
 * crypto mining indicators, network exfiltration, and obfuscated encoding.
 *
 * Follows the output-guard.ts pattern: an array of ScanRule objects iterated
 * against content, producing a ContentScanResult with findings.
 *
 * Pure function with no side effects -- accepts a string, returns structured findings.
 * Callers handle audit emission, logging, and blocking decisions.
 */

import {
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
  XML_SKILL_CLOSE_TAG,
  XML_SYSTEM_TAG,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity levels for content scan findings. */
export type ScanSeverity = "CRITICAL" | "WARN";

/** Category of content scan rule. */
export type ScanCategory =
  | "exec_injection"
  | "env_harvesting"
  | "crypto_mining"
  | "network_exfiltration"
  | "obfuscated_encoding"
  | "xml_breakout";

/** A single scan rule definition. */
export interface ScanRule {
  readonly id: string;
  readonly category: ScanCategory;
  readonly severity: ScanSeverity;
  readonly pattern: RegExp;
  readonly description: string;
  /** When true, scanner strips fenced code blocks before applying this rule. */
  readonly skipFencedBlocks?: boolean;
}

/** A single finding from content scanning. */
export interface ContentScanFinding {
  readonly ruleId: string;
  readonly category: ScanCategory;
  readonly severity: ScanSeverity;
  readonly description: string;
  readonly matchedText: string;
  readonly position: number;
  /** 1-based line number of the match in the original content. */
  readonly lineNumber: number;
}

/** Result of scanning skill body content. */
export interface ContentScanResult {
  readonly clean: boolean;
  readonly findings: readonly ContentScanFinding[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for matchedText in findings (prevents bloat). */
const MATCHED_TEXT_MAX_LENGTH = 100;

/**
 * Strip fenced code blocks (``` ... ```) from content.
 * Used by rules with skipFencedBlocks=true to avoid false positives
 * on code examples in documentation.
 */
function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

// ---------------------------------------------------------------------------
// Rule Definitions
// ---------------------------------------------------------------------------

/**
 * Exec injection patterns (CRITICAL).
 *
 * Targets actual injection syntax operators combined with dangerous binaries,
 * not mere mentions of command names in prose.
 * Patterns imported from @comis/core injection-patterns.ts.
 */
const EXEC_INJECTION_RULES: readonly ScanRule[] = [
  {
    id: "EXEC_SUBSHELL",
    category: "exec_injection",
    severity: "CRITICAL",
    pattern: EXEC_SUBSHELL_PATTERN,
    description: "Subshell command injection: $(command) with dangerous binary",
  },
  {
    id: "EXEC_BACKTICK",
    category: "exec_injection",
    severity: "CRITICAL",
    pattern: EXEC_BACKTICK_PATTERN,
    description: "Backtick command injection with dangerous binary",
    skipFencedBlocks: true,
  },
  {
    id: "EXEC_EVAL",
    category: "exec_injection",
    severity: "CRITICAL",
    pattern: EXEC_EVAL_PATTERN,
    description: "eval() with string argument",
  },
  {
    id: "EXEC_PIPE_BASH",
    category: "exec_injection",
    severity: "CRITICAL",
    pattern: EXEC_PIPE_BASH_PATTERN,
    description: "Pipe to shell interpreter",
  },
];

/**
 * Environment variable harvesting patterns (WARN).
 *
 * Targets mass-dump patterns, not individual $VAR references which are
 * ubiquitous in Markdown configuration instructions.
 * Patterns imported from @comis/core injection-patterns.ts.
 */
const ENV_HARVESTING_RULES: readonly ScanRule[] = [
  {
    id: "ENV_PRINTENV",
    category: "env_harvesting",
    severity: "WARN",
    pattern: ENV_PRINTENV_PATTERN,
    description: "printenv command dumps all environment variables",
  },
  {
    id: "ENV_PROC_ENVIRON",
    category: "env_harvesting",
    severity: "WARN",
    pattern: ENV_PROC_ENVIRON_PATTERN,
    description: "Direct read of process environment via /proc",
  },
  {
    id: "ENV_MASS_DUMP",
    category: "env_harvesting",
    severity: "WARN",
    pattern: ENV_MASS_DUMP_PATTERN,
    description: "Environment dump piped to exfiltration or encoding",
  },
];

/**
 * Crypto mining indicators (CRITICAL).
 *
 * Very low false-positive risk -- these terms almost never appear in
 * legitimate AI skill instructions.
 * Patterns imported from @comis/core injection-patterns.ts.
 */
const CRYPTO_MINING_RULES: readonly ScanRule[] = [
  {
    id: "CRYPTO_STRATUM",
    category: "crypto_mining",
    severity: "CRITICAL",
    pattern: CRYPTO_STRATUM_PATTERN,
    description: "Mining pool protocol (stratum://)",
  },
  {
    id: "CRYPTO_MINER_BINARY",
    category: "crypto_mining",
    severity: "CRITICAL",
    pattern: CRYPTO_MINER_BINARY_PATTERN,
    description: "Known cryptocurrency miner binary",
  },
  {
    id: "CRYPTO_POOL_DOMAIN",
    category: "crypto_mining",
    severity: "WARN",
    pattern: CRYPTO_POOL_DOMAIN_PATTERN,
    description: "Mining pool domain pattern",
  },
];

/**
 * Network exfiltration patterns (WARN/CRITICAL).
 *
 * Focuses on piped execution (curl | bash) rather than standalone URL references.
 * Reverse shell patterns are CRITICAL.
 * Patterns imported from @comis/core injection-patterns.ts.
 */
const NETWORK_EXFIL_RULES: readonly ScanRule[] = [
  {
    id: "NET_CURL_PIPE",
    category: "network_exfiltration",
    severity: "WARN",
    pattern: NET_CURL_PIPE_PATTERN,
    description: "curl output piped to interpreter",
  },
  {
    id: "NET_WGET_EXEC",
    category: "network_exfiltration",
    severity: "WARN",
    pattern: NET_WGET_EXEC_PATTERN,
    description: "wget output to stdout piped elsewhere",
  },
  {
    id: "NET_REVERSE_SHELL",
    category: "network_exfiltration",
    severity: "CRITICAL",
    pattern: NET_REVERSE_SHELL_PATTERN,
    description: "Reverse shell pattern",
  },
];

/**
 * Obfuscated encoding patterns (WARN/CRITICAL).
 *
 * Short base64 examples in documentation are fine. Only flags long encoded
 * blocks (likely obfuscated payload) or decode-and-execute chains.
 * Patterns imported from @comis/core injection-patterns.ts.
 */
const OBFUSCATED_ENCODING_RULES: readonly ScanRule[] = [
  {
    id: "OBF_BASE64_LONG",
    category: "obfuscated_encoding",
    severity: "WARN",
    pattern: OBF_BASE64_LONG_PATTERN,
    description: "Long base64-encoded string (80+ chars)",
  },
  {
    id: "OBF_HEX_LONG",
    category: "obfuscated_encoding",
    severity: "WARN",
    pattern: OBF_HEX_LONG_PATTERN,
    description: "Long hex-escaped string (20+ sequences)",
  },
  {
    id: "OBF_BASE64_DECODE_PIPE",
    category: "obfuscated_encoding",
    severity: "CRITICAL",
    pattern: OBF_BASE64_DECODE_PIPE_PATTERN,
    description: "base64 decode piped to another command",
  },
];

/**
 * XML breakout patterns (CRITICAL).
 *
 * Detects attempts to close skill XML structure tags or inject system-level
 * message tags within skill body content. These indicate an attacker trying
 * to escape the skill sandbox and inject instructions at a higher privilege level.
 * Patterns imported from @comis/core injection-patterns.ts.
 */
const XML_BREAKOUT_RULES: readonly ScanRule[] = [
  {
    id: "XML_SKILL_CLOSE",
    category: "xml_breakout",
    severity: "CRITICAL",
    pattern: XML_SKILL_CLOSE_TAG,
    description: "Closing tag for skill XML structure (breakout attempt)",
  },
  {
    id: "XML_SYSTEM_TAG",
    category: "xml_breakout",
    severity: "CRITICAL",
    pattern: XML_SYSTEM_TAG,
    description: "System-level message tag (breakout attempt)",
  },
];

// ---------------------------------------------------------------------------
// Combined Rule Array (exported for testability)
// ---------------------------------------------------------------------------

/** All content scan rules across all categories. */
export const CONTENT_SCAN_RULES: readonly ScanRule[] = [
  ...EXEC_INJECTION_RULES,
  ...ENV_HARVESTING_RULES,
  ...CRYPTO_MINING_RULES,
  ...NETWORK_EXFIL_RULES,
  ...OBFUSCATED_ENCODING_RULES,
  ...XML_BREAKOUT_RULES,
];

// ---------------------------------------------------------------------------
// Scan Function
// ---------------------------------------------------------------------------

/**
 * Scan a skill body for suspicious content patterns.
 *
 * Iterates all rules against the content, accumulating findings.
 * Returns `{ clean: true, findings: [] }` when no patterns match.
 *
 * Pure function -- no side effects, no event emission, no logging.
 * Callers are responsible for audit events and blocking decisions.
 *
 * @param content - Sanitized skill body content to scan
 * @returns Scan result with clean flag and array of findings
 */
export function scanSkillContent(content: string): ContentScanResult {
  const findings: ContentScanFinding[] = [];

  // Pre-compute stripped content lazily (only if a rule needs it)
  let strippedContent: string | null = null;

  for (const rule of CONTENT_SCAN_RULES) {
    // Determine which content to scan against
    const scanTarget = rule.skipFencedBlocks
      ? (strippedContent ??= stripFencedCodeBlocks(content))
      : content;

    // Always reset lastIndex before exec loop
    rule.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(scanTarget)) !== null) {
      const matchedText = match[0].length > MATCHED_TEXT_MAX_LENGTH
        ? match[0].slice(0, MATCHED_TEXT_MAX_LENGTH)
        : match[0];

      // Compute position in original content for line number calculation
      let positionInOriginal: number;
      if (rule.skipFencedBlocks) {
        // Find the matched text in the original content
        const idx = content.indexOf(match[0]);
        positionInOriginal = idx >= 0 ? idx : match.index;
      } else {
        positionInOriginal = match.index;
      }

      // 1-based line number from position in original content
      const lineNumber = content.slice(0, positionInOriginal).split("\n").length;

      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        description: rule.description,
        matchedText,
        position: match.index,
        lineNumber,
      });
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}
