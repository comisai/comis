// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Skills system configuration schema.
 *
 * Controls skill discovery paths, built-in tool toggles,
 * prompt skill configuration, and eligibility filtering.
 */
const BuiltinToolsSchema = z.strictObject({
    /** Read file contents with line numbers and pagination */
    read: z.boolean().default(true),
    /** Write or overwrite files; auto-creates parent directories */
    write: z.boolean().default(true),
    /** Surgical search-and-replace on files (exact text match) */
    edit: z.boolean().default(true),
    /** Cell-level Jupyter notebook editing */
    notebookEdit: z.boolean().default(true),
    /** Regex search across files (ripgrep-based, respects .gitignore). Requires `rg` system binary. */
    grep: z.boolean().default(true),
    /** Find files by glob pattern (fd-based, respects .gitignore). Requires `fd` system binary. */
    find: z.boolean().default(true),
    /** List directory contents alphabetically, including dotfiles */
    ls: z.boolean().default(true),
    /** Shell command execution with foreground/background modes */
    exec: z.boolean().default(true),
    /** Background process management (list, kill, status, log) */
    process: z.boolean().default(true),
    /** Web search API integration */
    webSearch: z.boolean().default(true),
    /** URL content fetching */
    webFetch: z.boolean().default(true),
    /** Headless browser control (requires Playwright/Chromium) */
    browser: z.boolean().default(false),
  });

const ToolPolicySchema = z.strictObject({
    /** Named profile: controls baseline tool set */
    profile: z.enum(["minimal", "coding", "messaging", "supervisor", "full"]).default("full"),
    /** Additional tools to allow beyond the profile (tool names or group:xxx) */
    allow: z.array(z.string()).default([]),
    /** Tools to deny even if in the profile (tool names or group:xxx) */
    deny: z.array(z.string()).default([]),
  });

/**
 * Prompt-based skills configuration.
 * Controls limits, behavior, and eligibility for Markdown instruction skills.
 */
export const PromptSkillsConfigSchema = z.strictObject({
    /** Maximum skill body length in characters (default: 20000) */
    maxBodyLength: z.number().int().positive().default(20_000),
    /** Enable dynamic context -- shell command execution in skill bodies (default: false) */
    enableDynamicContext: z.boolean().default(false),
    /** Maximum prompt skills auto-injected per request (default: 3) */
    maxAutoInject: z.number().int().min(0).max(20).default(3),
    /** Skill names allowed for this agent. Empty array = allow all discovered skills. */
    allowedSkills: z.array(z.string()).default([]),
    /** Skill names denied for this agent. Applied after allowedSkills filter. */
    deniedSkills: z.array(z.string()).default([]),
  });

/** Runtime eligibility filtering configuration. */
const RuntimeEligibilitySchema = z.strictObject({
  /** Enable runtime eligibility filtering based on os, binary, and env var prerequisites (default: true). */
  enabled: z.boolean().default(true),
});

/** Content scanning configuration for skill bodies at load time. */
const ContentScanningSchema = z.strictObject({
  /** Enable content scanning at skill load time (default: true). */
  enabled: z.boolean().default(true),
  /** Block skill loading when CRITICAL findings are present (default: true). */
  blockOnCritical: z.boolean().default(true),
});

/**
 * Exec tool OS-level sandbox configuration.
 *
 * Controls whether child processes spawned by the exec tool are wrapped
 * in a platform sandbox (bwrap on Linux, sandbox-exec on macOS).
 */
const ExecSandboxSchema = z.strictObject({
  /**
   * Whether OS-level sandboxing is active for exec tool commands.
   * - "always": sandbox is enabled; if the sandbox binary is unavailable the
   *   exec tool logs a warning and runs unsandboxed (graceful fallback).
   * - "never": sandbox is unconditionally disabled.
   */
  enabled: z.enum(["always", "never"]).default("always"),
  /** Additional read-only paths to expose inside the sandbox (e.g., shared data dirs). */
  readOnlyAllowPaths: z.array(z.string()).default([]),
});

/**
 * discover_tools score-floor configuration.
 * Why: zero-signal queries can surface incidental BM25 matches or cosine-noise
 * hits. Thresholds filter ranked results before slicing, forcing "no matches"
 * responses when nothing crosses the floor. Tunable so operators can adjust
 * per-deployment without a rebuild.
 */
const ToolDiscoverySchema = z.strictObject({
  /** Minimum BM25 score as FRACTION OF TOP MATCH (0..1). Default 0.8.
   *  As of 2026-04-23, BM25 scores are normalized to [0, 1] before this floor
   *  applies, matching the semantics of minHybridScore. A value of 0.8 means
   *  "return only tools scoring >= 80% of the top match". Values > 1.0 fail
   *  validation at config load (stale raw-score overrides would produce zero
   *  matches under the new normalized semantics; fail-fast surfaces the
   *  error immediately per AGENTS.md §3.4). See design §5.6:
   *  .planning/design/discover-tools-bm25-fallback-fix.md */
  minBm25Score: z.number().min(0).max(1).default(0.8),
  /** Minimum combined score (0..1 normalized) for hybrid mode. Default 0.35. */
  minHybridScore: z.number().min(0).max(1).default(0.35),
});

export const SkillsConfigSchema = z.strictObject({
    /** Directories to scan for SKILL.md files (relative to data dir) */
    discoveryPaths: z.array(z.string()).default(["./skills"]),

    /** Built-in tool toggles (enabled/disabled by config) */
    builtinTools: BuiltinToolsSchema.default(() => BuiltinToolsSchema.parse({})),

    /** Tool policy: controls which tools are available per agent */
    toolPolicy: ToolPolicySchema.default(() => ToolPolicySchema.parse({})),

    /** Prompt-based skill configuration (Markdown instruction skills) */
    promptSkills: PromptSkillsConfigSchema.default(() => PromptSkillsConfigSchema.parse({})),

    /** Runtime eligibility filtering: exclude skills whose OS/binary/env prerequisites are not met */
    runtimeEligibility: RuntimeEligibilitySchema.default(() => RuntimeEligibilitySchema.parse({})),

    /** Content scanning: detect dangerous patterns in skill bodies at load time */
    contentScanning: ContentScanningSchema.default(() => ContentScanningSchema.parse({})),

    /** Exec tool OS-level sandbox configuration */
    execSandbox: ExecSandboxSchema.default(() => ExecSandboxSchema.parse({})),

    /** discover_tools score-floor thresholds (BM25 + hybrid). */
    toolDiscovery: ToolDiscoverySchema.default(() => ToolDiscoverySchema.parse({})),

    /** Enable file watching for automatic skill reload (default: true). */
    watchEnabled: z.boolean().default(true),
    /** Debounce interval in milliseconds for file change coalescing (default: 400). */
    watchDebounceMs: z.number().int().min(100).max(5000).default(400),
  });

/** Inferred skills configuration type. */
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/** Inferred prompt skills configuration type. */
export type PromptSkillsConfig = z.infer<typeof PromptSkillsConfigSchema>;

/** Inferred tool discovery configuration type. */
export type ToolDiscoveryConfig = z.infer<typeof ToolDiscoverySchema>;
