import type { Result } from "@comis/shared";

/**
 * Permissions required by a skill to execute.
 * Mirrors the Node.js --permission flag categories.
 */
export interface SkillPermissions {
  /** Filesystem read access paths (e.g. ["/tmp/skill-data"]) */
  fsRead?: string[];
  /** Filesystem write access paths */
  fsWrite?: string[];
  /** Network access domains (e.g. ["api.example.com"]) */
  net?: string[];
  /** Environment variable access (read-only, specific keys) */
  env?: string[];
}

/**
 * Input provided to a skill when it executes.
 */
export interface SkillInput {
  /** The name of the skill being invoked */
  name: string;
  /** Parameters passed to the skill */
  params: Record<string, unknown>;
  /** Timeout in milliseconds (enforced by the sandbox) */
  timeoutMs?: number;
}

/**
 * Output returned by a skill after execution.
 */
export interface SkillOutput {
  /** Whether the skill completed successfully */
  success: boolean;
  /** The result data (arbitrary JSON-serializable value) */
  data?: unknown;
  /** Error message if the skill failed */
  error?: string;
  /** Execution time in milliseconds */
  durationMs: number;
}

/**
 * Metadata about a registered skill.
 */
export interface SkillManifest {
  /** Unique skill name (e.g. "web-search", "file-reader") */
  name: string;
  /** Human-readable description for the agent to decide when to use it */
  description: string;
  /** JSON Schema describing the expected params */
  inputSchema: Record<string, unknown>;
  /** Permissions this skill requires */
  permissions: SkillPermissions;
  /** Maximum execution time in milliseconds */
  maxTimeoutMs: number;
}

/**
 * SkillPort: The hexagonal architecture boundary for skill execution.
 *
 * Each skill is a Markdown instruction file with declared permissions.
 * Prompt skills are loaded, sanitized, and injected into the agent's
 * system prompt at execution time.
 *
 * The port handles:
 * - Permission validation before execution
 * - Timeout enforcement
 * - Structured output
 */
export interface SkillPort {
  /**
   * The skill manifest describing capabilities and requirements.
   */
  readonly manifest: SkillManifest;

  /**
   * Validate that the input matches the skill's input schema.
   *
   * @param input - The skill input to validate
   * @returns true if valid, or a descriptive error
   */
  validate(input: SkillInput): Result<true, Error>;

  /**
   * Execute the skill in a sandboxed environment.
   *
   * The implementation must:
   * 1. Validate input (via `validate()`)
   * 2. Enforce timeout (via `input.timeoutMs` or `manifest.maxTimeoutMs`)
   * 3. Run in isolation (no access beyond declared permissions)
   * 4. Return structured output
   *
   * @param input - The validated skill input
   * @returns The skill output, or an error if execution failed catastrophically
   */
  execute(input: SkillInput): Promise<Result<SkillOutput, Error>>;
}
