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
    /** Headless browser control (requires Playwright/Chromium). Default true —
     * the browser tool is available out of the box; a missing Chromium binary
     * fails honestly at use, and `orch:browse` stays approval-gated. */
    browser: z.boolean().default(true),
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
 * Bounded-unpack caps for the staged skill-import pipeline. Every field is
 * fully defaulted (consumers read a resolved config, never `?? fallback`) and
 * the object is closed — an unknown or typo'd cap key rejects at config load.
 * The defaults are deliberately conservative; there is intentionally NO
 * auto-connect knob (imported-tier MCP entries persist disabled by construction).
 */
const SkillsImportConfigSchema = z.strictObject({
  /** Max compressed archive size accepted for fetch/decode (default: 8 MiB). */
  maxArchiveBytes: z.number().int().positive().default(8_388_608),
  /** Max total uncompressed bytes, stream-counted mid-inflate (default: 64 MiB). */
  maxTotalUncompressedBytes: z.number().int().positive().default(67_108_864),
  /** Max number of entries unpacked from one archive (default: 200). */
  maxFileCount: z.number().int().positive().default(200),
  /** Max size of any single unpacked file (default: 4 MiB). */
  maxFileBytes: z.number().int().positive().default(4_194_304),
  /** Max path depth of any unpacked entry (default: 10). */
  maxPathDepth: z.number().int().positive().default(10),
  /**
   * Registry allowlist for skill imports: normalized origins
   * (`https://<host>[:port]`) plus the literal `clawhub` token. Default-empty
   * means no registry imports are permitted (archive/GitHub imports are
   * unaffected). Matched exactly against the requested registry at import time.
   */
  registries: z.array(z.string()).default([]),
  /**
   * Require an official registry publisher (channel:"official" / isOfficial)
   * for a clawhub import: a non-official publisher records
   * `officialPublisher:false` and requires an explicit `confirm` (never applies
   * to archive/github/wellknown). Default `true` (fail-closed) — an operator
   * opts out per agent by setting it `false`.
   *
   * The official/non-official signal is SERVER-ASSERTED by the registry (its
   * self-claimed isOfficial / channel), so this gate is a publisher-provenance
   * signal, not a cryptographic guarantee — a compromised registry could claim
   * official. The integrity floor is the self-computed content-hash pin over the
   * installed set plus TLS, independent of this flag.
   */
  requireOfficialPublisher: z.boolean().default(true),
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
   *  validation at config load (a raw-score override above 1.0 would produce
   *  zero matches under the normalized semantics; fail-fast surfaces the
   *  error immediately). */
  minBm25Score: z.number().min(0).max(1).default(0.8),
  /** Minimum combined score (0..1 normalized) for hybrid mode. Default 0.35. */
  minHybridScore: z.number().min(0).max(1).default(0.35),
});

/**
 * One allowlist entry for the interactive terminal driver.
 *
 * `z.strictObject` at EVERY level: unknown/typo'd keys throw at config load
 * rather than being silently dropped, so an operator-declared restriction is
 * always actually parsed. The `allow` list is operator config only —
 * never agent-extensible. The whole entry shape is modelled even though
 * the worker consumes only a subset (`match` + `scope`); the full allow-set
 * must round-trip regardless.
 *
 * `~/.comis` is NOT represented here — it is an always-on, non-configurable
 * carve-out, deliberately not an operator-dialable field.
 */
const TerminalAllowEntrySchema = z.strictObject({
  /** Stable entry id the agent passes to terminal_session_create as `allowId`. */
  id: z.string().min(1),
  /** Canonical-binary match: operator absolute path, optional argv-prefix + content hash pin. */
  match: z.strictObject({
    path: z.string(),
    argsPrefix: z.array(z.string()).optional(),
    hash: z.string().optional(),
  }),
  /** Least-privilege sandbox scope materialized per session (not every scope dimension is materialized yet). */
  scope: z.strictObject({
    filesystem: z.enum(["workspace", "listed-paths", "home", "full"]).default("workspace"),
    paths: z.array(z.string()).optional(),
    network: z.enum(["none", "listed-hosts", "full"]).default("none"),
    hosts: z.array(z.string()).optional(),
    credentialPaths: z.array(z.string()).default([]),
    uid: z.enum(["dedicated", "daemon"]).default("dedicated"),
  }),
  /** Auto-answer policy for safe interaction prompts. */
  autoAnswer: z.enum(["none", "safe-only", "all"]).default("safe-only"),
  /** Optional safe-pattern allowlist feeding the interaction classifier. */
  hintPatterns: z.array(z.string()).optional(),
  /** Explicit operator risk acknowledgement — `acknowledgedRisk` must be literal true. */
  consent: z.strictObject({
    acknowledgedRisk: z.literal(true),
    acknowledgedAt: z.string(),
  }),
  /**
   * Per-entry resource caps (all optional). `wallClockMs` / `maxInteractions` are the
   * endurance-dialable caps: each is `.int().optional()`, so `undefined` ⇒
   * NO cap and an operator dials it to a 40h+ horizon. They stay
   * cap-only knobs with NO `.default()` on purpose — adding a default would impose a cap
   * where the contract is "absent means uncapped". The high-default + reaper-exclusion +
   * cap-named `failed` reason are the daemon's runtime concern (the reaper wiring), not a
   * schema default. A cap eviction names the cap that fired — a session is never evicted
   * for duration/quietness alone.
   */
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
  /** PTY backend; tmux is required for long-run mode. */
  backend: z.enum(["spawn", "tmux"]).optional(),
  /** Optional hardening tier. */
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
 * The terminal worker's reaper + emulator caps. Every field carries a production DEFAULT
 * so a PARTIAL `terminal` block (e.g. just `unsafeDisableSandbox: true` on a bwrap-less
 * host) parses without the operator restating the whole worker object. `stuckMs` mirrors
 * the runtime `STUCK_DEFAULT_MS` and `maxConcurrentAttentionTurns` the daemon
 * `DEFAULT_MAX_CONCURRENT` — @comis/core cannot import @comis/skills / @comis/daemon, so
 * the values are inlined. Closed `z.strictObject`: an unknown/typo'd worker key still rejects.
 */
const TerminalWorkerSchema = z.strictObject({
  maxSessions: z.number().int().default(8),
  idleTtlMs: z.number().int().default(900_000),
  ringBytes: z.number().int().default(262_144),
  stuckMs: z.number().int().default(30_000), // mirrors terminal-worker-defaults STUCK_DEFAULT_MS
  maxConcurrentAttentionTurns: z.number().int().default(4), // mirrors daemon DEFAULT_MAX_CONCURRENT
  /**
   * The operator-dialable cgroup `TasksMax` ceiling bounding the concurrent-session
   * subprocess footprint vs. the systemd `TasksMax`. The tmux
   * backend makes a worker's named sessions outlive the worker, so N
   * memory-hungry sessions share one cgroup; this bounds the fork footprint so an
   * unbounded fan-out cannot OOM/fork-starve the daemon. Absent ⇒ bounded by
   * `maxSessions` alone (no extra ceiling). Optional + positive — adding it keeps the
   * `worker` block a `strictObject` (an unknown/typo'd worker key still rejects).
   */
  tasksMax: z.number().int().positive().optional(),
});

/**
 * The per-session emulator geometry. Defaults mirror the worker's own fallbacks
 * (`cols:80`/`rows:24` in terminal-worker-entry) + `SCROLLBACK_DEFAULT` (1000), so a
 * partial `terminal` block need not restate them. Closed `z.strictObject`.
 */
const TerminalEmulatorDefaultsSchema = z.strictObject({
  cols: z.number().int().default(80),
  rows: z.number().int().default(24),
  scrollback: z.number().int().default(1000), // mirrors terminal-worker-defaults SCROLLBACK_DEFAULT
});

/** Terminal-driver audit toggle. Defaults ON — a security-sensitive subsystem audits by default. */
const TerminalAuditSchema = z.strictObject({ enabled: z.boolean().default(true) });

/**
 * Closed configuration schema for the interactive terminal driver.
 *
 * Operator-dialable, never agent-dialable. Closed by construction (every level
 * is `z.strictObject`) so unknown/typo'd keys are rejected at config load —
 * the gate against a believed-but-unparsed restriction.
 *
 * Every field carries a production DEFAULT (via the named sub-schemas above), so a
 * MINIMAL block parses — e.g. `terminal: { unsafeDisableSandbox: true }` on a bwrap-less
 * host, instead of forcing the operator to restate worker/defaults/redactSecrets/audit.
 * The parent `terminal:` key stays `.optional()`, so an ABSENT block is still `undefined`
 * (the fail-closed unconfigured-agent posture, unchanged); the defaults only fill a
 * PARTIALLY-specified block. `unsafeDisableSandbox` keeps its own `false` default (the jail
 * stays ON unless the operator explicitly opts out).
 */
export const TerminalDriverConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  worker: TerminalWorkerSchema.default(() => TerminalWorkerSchema.parse({})),
  defaults: TerminalEmulatorDefaultsSchema.default(() => TerminalEmulatorDefaultsSchema.parse({})),
  allow: z.array(TerminalAllowEntrySchema).default([]),
  redactSecrets: z.boolean().default(true),
  audit: TerminalAuditSchema.default(() => TerminalAuditSchema.parse({})),
  /**
   * Operator opt-out of the bwrap jail — DANGEROUS, default `false`. When `true`, a
   * `terminal_session_create` runs the driven CLI DIRECTLY (no bwrap) instead of failing closed
   * when the jail cannot be materialized. It exists for constrained hosts that genuinely cannot run
   * bwrap (a container without unprivileged user-namespaces, a locked-down CI box) so the
   * coding-CLI drive can run at all — the exact peer of `browser.noSandbox`.
   *
   * SECURITY POSTURE: this removes ALL filesystem / network / uid confinement (the `allow[].scope`
   * dimensions are unenforceable without the jail) — a genuine downgrade. Two protections are
   * PRESERVED and never optional: (1) the env-scrub still strips daemon secrets (gateway token /
   * master key) from the child env, so an unsandboxed CLI still cannot read them; (2) a durable
   * `backend:"tmux"` drive is force-downgraded to the non-durable PTY backend (a tmux server would
   * inherit env the jail's per-session `--unsetenv` normally strips). The relaxation is surfaced at
   * boot in `config_posture` (`terminalUnsafeDisableSandbox`), never silent. It lives under
   * `agents.*` (an immutable config prefix), so an agent can never self-enable it via `config.patch`
   * — operator config files / env only. Leave it `false` on any host where bwrap is available.
   */
  unsafeDisableSandbox: z.boolean().default(false),
  /**
   * Autonomous-drive policy. OPTIONAL + `strictObject`: the block is purely
   * additive — a config with NO `drive` block parses cleanly and yields the inert
   * baseline behavior. The block carries
   * the promotion mode (`mode`) + default wake-read shape (`readMode`), the three
   * endurance/durability fields (`durable` / `heartbeatMs` / `maxCostUsd`), and the two
   * user-facing notification fields (`notify` / `heartbeatNotifyMs`). The
   * optional-block + per-field-`.default(...)` discipline keeps each field's addition
   * independent (an unknown/typo'd `drive.*` key still rejects). The per-field defaults
   * preserve the inert baseline — `mode:"auto"` only promotes a genuinely-long drive;
   * `readMode:"digest"` is already the tool's effective default; `heartbeatMs:90_000` /
   * `maxCostUsd:null` are inert. LOCKED: `durable:true` is
   * ACCEPTED at config-validation even on a tmux-less host (tmux availability is a RUNTIME
   * property — degrade + WARN, never a config-time hard-require). Changing/adding a default
   * regenerates the `section-registry-parity` snapshot (a validate-only gate).
   */
  drive: z
    .strictObject({
      /** Auto-promote (default) / never promote (the inline drive) / always promote at first wait. */
      mode: z.enum(["auto", "attached", "detached"]).default("auto"),
      /** Default wake-read shape: a bounded digest / only changed rows / the whole bounded screen. */
      readMode: z.enum(["digest", "diff", "full"]).default("digest"),
      /**
       * Make the drive DURABLE: launch the driven CLI inside a detached
       * tmux server (implying `backend:"tmux"` at runtime) so a worker/daemon exit
       * leaves it running, and re-attach (never restart, never double-drive) on
       * daemon restart. DEFAULT `true`: the tmux backend is both
       * DRIVEABLE (the node-pty `attach` path — streams + accepts input) and
       * SURVIVES-A-RESTART (the deployed unit ships `KillMode=process` + the data-dir
       * tmux socket), so it is the default working setup; set `durable:false` to opt
       * out to the non-durable pty drive. LOCKED: `durable:true` is ACCEPTED
       * HERE even on a tmux-less host — tmux availability is a RUNTIME property; an
       * unavailable/failed re-attach degrades to a non-durable drive + a logged WARN
       * (and an honest `failed` on a subsequent restart), NOT a config-validation
       * hard-require. Do NOT add a config-time tmux check. (The runtime effective
       * default lives in buildTerminalSharedDeps' `?? true` — this default applies
       * when a `drive` block is present but omits `durable`.)
       */
      durable: z.boolean().default(true),
      /**
       * The INTERNAL coarse liveness-backstop interval (ms). A safety net
       * UNDER the event-driven wake: on a tick with NO intervening transition it
       * performs a SINGLE liveness check and synthesizes `stuck` only when genuinely
       * hung — a legitimately-busy long compile/test is busy, NOT `stuck`. NEVER
       * a hot-path poll (no per-tick screen read). Default 90_000 (90s). This is the
       * internal liveness tick, NOT the user-facing progress heartbeat
       * (`heartbeatNotifyMs` below).
       */
      heartbeatMs: z.number().int().positive().default(90_000),
      /**
       * An optional per-drive SPEND CEILING (USD) over the whole run.
       * On breach the drive escalates/stops — never silent overspend. `null` (default)
       * = uncapped. Carries no privilege/path/credential — it bounds cost only.
       */
      maxCostUsd: z.number().nullable().default(null),
      /**
       * Which terminal-outcome notifications reach the USER: `terminal`
       * (default) = `done`/`needs-you`/`failed` only; `all` = RESERVED for a future
       * per-wake debug stream and **currently behaves exactly like `terminal`** (the
       * per-wake notification is not yet implemented); `none` = non-escalation
       * suppressed. An escalation STILL fires under `none` (a needs-you IS a terminal
       * notification) — `notify` NEVER weakens the escalate-always guarantee or the
       * interaction loop-guard, it only gates the uninteresting middle. Default
       * `terminal` preserves the conservative spam-free posture. Carries no
       * privilege/path/credential — a policy knob only.
       */
      notify: z.enum(["terminal", "all", "none"]).default("terminal"),
      /**
       * The user-facing progress-heartbeat cadence (ms) for a
       * PROMOTED long drive: a coarse, content-free one-liner from the journal so a
       * 40h drive is not 40h of silence. `0` = terminal-only (no heartbeat).
       * Default 3_600_000 (1h) — a spam-free coarse cadence. `.int().nonnegative()`
       * (NOT `.positive()`) BECAUSE `0` is the meaningful "terminal-only" value — this is
       * DISTINCT from `heartbeatMs` (the INTERNAL liveness backstop above, `.positive()`,
       * NOT a user message). A short (unpromoted) drive emits none. Carries no
       * privilege/path/credential — a cadence knob only.
       */
      heartbeatNotifyMs: z.number().int().nonnegative().default(3_600_000),
    })
    .optional(),
});

/** Inferred terminal driver configuration type. */
export type TerminalDriverConfig = z.infer<typeof TerminalDriverConfigSchema>;

/**
 * A single parsed terminal allow entry. The daemon wiring
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

    /** Bounded-unpack caps for the staged skill-import pipeline (shared-scope reads the default agent's block) */
    import: SkillsImportConfigSchema.default(() => SkillsImportConfigSchema.parse({})),

    /** Exec tool OS-level sandbox configuration */
    execSandbox: ExecSandboxSchema.default(() => ExecSandboxSchema.parse({})),

    /** discover_tools score-floor thresholds (BM25 + hybrid). */
    toolDiscovery: ToolDiscoverySchema.default(() => ToolDiscoverySchema.parse({})),

    /** Enable file watching for automatic skill reload (default: true). */
    watchEnabled: z.boolean().default(true),
    /** Debounce interval in milliseconds for file change coalescing (default: 400). */
    watchDebounceMs: z.number().int().min(100).max(5000).default(400),

    /**
     * Interactive terminal driver — the operator allowlist + worker caps + scope
     * matrix. OPTIONAL + fail-closed by construction: when absent (the default),
     * the daemon wires an EMPTY allow-set (every `terminal_session_create` rejects before
     * any spawn) and NO reaper. The daemon threads this into its
     * `TerminalWiringDeps` so the allow-set populates (per-session caps go live) and
     * `worker.{maxSessions,idleTtlMs,stuckMs}` feed the reaper. The whole shape is a closed
     * `z.strictObject`: an unknown/typo'd terminal key rejects at config load.
     */
    terminal: TerminalDriverConfigSchema.optional(),
  });

/** Inferred skills configuration type. */
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/** Inferred prompt skills configuration type. */
export type PromptSkillsConfig = z.infer<typeof PromptSkillsConfigSchema>;

/** Inferred staged-import unpack-caps configuration type. */
export type SkillsImportConfig = z.infer<typeof SkillsImportConfigSchema>;

/** Inferred tool discovery configuration type. */
export type ToolDiscoveryConfig = z.infer<typeof ToolDiscoverySchema>;
