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
  /** Packages to pip-install into workspace venv on first creation.
   *  Default ["requests==2.32.3"]. Set [] to disable.
   *  Values are passed verbatim to pip install — include version pins as needed
   *  (e.g., "requests==2.32.3"). Only applies on non-Docker hosts; Docker
   *  images seed the venv at build time (Dockerfile:349). */
  warmVenvSeed: z.array(z.string()).default(["requests==2.32.3"]),
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
   *  BM25 scores are normalized to [0, 1] before this floor applies,
   *  matching the semantics of minHybridScore. A value of 0.8 means
   *  "return only tools scoring >= 80% of the top match". Values > 1.0 fail
   *  validation at config load (stale raw-score overrides would produce zero
   *  matches under the new normalized semantics; fail-fast surfaces the
   *  error immediately). */
  minBm25Score: z.number().min(0).max(1).default(0.8),
  /** Minimum combined score (0..1 normalized) for hybrid mode. Default 0.35. */
  minHybridScore: z.number().min(0).max(1).default(0.35),
});

/**
 * One allowlist entry for the interactive terminal driver (spec §6).
 *
 * `z.strictObject` at EVERY level: unknown/typo'd keys throw at config load
 * rather than being silently dropped, so an operator-declared restriction is
 * always actually parsed. The `allow` list is operator config only —
 * never agent-extensible. The whole spec §6 shape is modelled now even though
 * the initial worker consumes only a subset (`match` + `scope`); later work
 * consumes the rest, and the full allow-set must round-trip.
 *
 * `~/.comis` is NOT represented here — it is an always-on, non-configurable
 * carve-out (§3.4), deliberately not an operator-dialable field.
 */
const TerminalAllowEntrySchema = z.strictObject({
  /** Stable entry id the agent passes to terminal_session_create as `allowId`. */
  id: z.string().min(1),
  /** Canonical-binary match (§3.2): operator absolute path, optional argv-prefix + content hash pin. */
  match: z.strictObject({
    path: z.string(),
    argsPrefix: z.array(z.string()).optional(),
    hash: z.string().optional(),
  }),
  /** Least-privilege sandbox scope materialized per session (the full matrix lands later). */
  scope: z.strictObject({
    filesystem: z.enum(["workspace", "listed-paths", "home", "full"]).default("workspace"),
    paths: z.array(z.string()).optional(),
    network: z.enum(["none", "listed-hosts", "full"]).default("none"),
    hosts: z.array(z.string()).optional(),
    credentialPaths: z.array(z.string()).default([]),
    uid: z.enum(["dedicated", "daemon"]).default("dedicated"),
  }),
  /** Auto-answer policy for safe interaction prompts (§4.5). */
  autoAnswer: z.enum(["none", "safe-only", "all"]).default("safe-only"),
  /** Optional safe-pattern allowlist feeding the interaction classifier (§4.5). */
  hintPatterns: z.array(z.string()).optional(),
  /** Explicit operator risk acknowledgement — `acknowledgedRisk` must be literal true. */
  consent: z.strictObject({
    acknowledgedRisk: z.literal(true),
    acknowledgedAt: z.string(),
  }),
  /** Per-entry resource caps (all optional). */
  limits: z
    .strictObject({
      maxSessions: z.number().int().optional(),
      maxRequestsPerSession: z.number().int().optional(),
      wallClockMs: z.number().int().optional(),
      maxInteractions: z.number().int().optional(),
    })
    .optional(),
  /** Require operator approval at session_create for this entry. */
  approveOnCreate: z.boolean().optional(),
  /** PTY backend; tmux is required for long-run mode (§4.6). */
  backend: z.enum(["spawn", "tmux"]).optional(),
  /** Optional hardening tier (§3.9). */
  hardening: z.enum(["none", "broker-decoy"]).default("none"),
  /** Broker-decoy binding (only meaningful when hardening = "broker-decoy"). */
  brokerDecoy: z
    .strictObject({
      bindingHostPaths: z.array(z.string()),
      tokenSource: z.enum(["operator", "comis-oauth"]),
      decoyPath: z.string(),
    })
    .optional(),
});

/**
 * Closed configuration schema for the interactive terminal driver (spec §6).
 *
 * Operator-dialable, never agent-dialable. Closed by construction (every level
 * is `z.strictObject`) so unknown/typo'd keys are rejected at config load —
 * the gate against a believed-but-unparsed restriction.
 */
export const TerminalDriverConfigSchema = z.strictObject({
  enabled: z.boolean(),
  worker: z.strictObject({
    maxSessions: z.number().int(),
    idleTtlMs: z.number().int(),
    ringBytes: z.number().int(),
    stuckMs: z.number().int(),
    maxConcurrentAttentionTurns: z.number().int(),
    /**
     * The operator-dialable cgroup `TasksMax` ceiling bounding the concurrent-session
     * subprocess footprint vs. the systemd `TasksMax` (OPS-05; T-124-22). The tmux
     * backend (124-08) makes a worker's named sessions outlive the worker, so N
     * memory-hungry sessions share one cgroup; this bounds the fork footprint so an
     * unbounded fan-out cannot OOM/fork-starve the daemon. Absent ⇒ bounded by
     * `maxSessions` alone (no extra ceiling). Optional + positive — adding it keeps the
     * `worker` block a `strictObject` (an unknown/typo'd worker key still rejects, OPS-02).
     */
    tasksMax: z.number().int().positive().optional(),
  }),
  defaults: z.strictObject({
    cols: z.number().int(),
    rows: z.number().int(),
    scrollback: z.number().int(),
  }),
  allow: z.array(TerminalAllowEntrySchema).default([]),
  redactSecrets: z.boolean(),
  audit: z.strictObject({ enabled: z.boolean() }),
});

/** Inferred terminal driver configuration type. */
export type TerminalDriverConfig = z.infer<typeof TerminalDriverConfigSchema>;

/**
 * A single parsed terminal allow entry (spec §6). The daemon wiring
 * (`setup-terminal-tools.ts:mapAllowEntry`) maps this onto the skills-side
 * `AllowEntryLike`, threading `{id, match, scope}` so the operator-declared scope
 * reaches the worker. Scope sub-fields are already default-applied by the
 * schema (least-privilege), so the mapping is a pure passthrough.
 */
export type TerminalAllowEntry = TerminalDriverConfig["allow"][number];

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

    /**
     * Interactive terminal driver (v2.11) — the operator allowlist + worker caps + scope
     * matrix (spec §6). OPTIONAL + fail-closed by construction: when absent (the default),
     * the daemon wires an EMPTY allow-set (every `terminal_session_create` rejects before
     * any spawn) and NO reaper. P5/Phase 124 threads this into the daemon's
     * `TerminalWiringDeps` so the allow-set populates (per-session caps go live) and
     * `worker.{maxSessions,idleTtlMs,stuckMs}` feed the reaper. The whole shape is a closed
     * `z.strictObject` (OPS-02): an unknown/typo'd terminal key rejects at config load.
     */
    terminal: TerminalDriverConfigSchema.optional(),
  });

/** Inferred skills configuration type. */
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/** Inferred prompt skills configuration type. */
export type PromptSkillsConfig = z.infer<typeof PromptSkillsConfigSchema>;

/** Inferred tool discovery configuration type. */
export type ToolDiscoveryConfig = z.infer<typeof ToolDiscoverySchema>;
