// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/** A single finding from output scanning. */
export interface OutputGuardFinding {
  readonly type: "secret_leak" | "canary_leak" | "prompt_extraction";
  readonly pattern: string;
  readonly position: number;
  readonly severity: "critical" | "warning";
}

/** Result of scanning an LLM response. */
export interface OutputGuardResult {
  readonly safe: boolean;
  /** True when any critical finding was redacted in `sanitized`. */
  readonly blocked: boolean;
  readonly findings: readonly OutputGuardFinding[];
  readonly sanitized: string;
}

/** Port interface for scanning LLM output before delivery. */
export interface OutputGuardPort {
  scan(response: string, context?: { canaryToken?: string }): Result<OutputGuardResult, Error>;
}
