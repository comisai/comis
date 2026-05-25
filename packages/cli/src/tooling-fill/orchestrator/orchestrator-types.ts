// SPDX-License-Identifier: Apache-2.0
/**
 * tooling-fill orchestrator types.
 *
 * Public types (PromptIO, OrchestratorOpts, OrchestratorResult) and the
 * internal pipeline-stage hand-off types (HintEntry, FilledEntry, SkippedEntry,
 * RollbackOutcome) consumed across the discover/fill/verify leaves. Pure
 * type declarations + the load-bearing literal strings shared across stages
 * (anchored by anti-regression greps in the integration tests).
 *
 * @module
 */
import type { FillKind } from "../apply-hint.js";
import type { HintShape } from "../validators.js";
import type { Supervisor } from "../supervisor.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Operator interactions are injected; testable without a real TTY.
 * Real implementation in `commands/config.ts` wraps node:readline/promises.
 */
export interface PromptIO {
  /** Show the diff and ask "apply these values?" — y/yes resolves true. */
  readonly confirmValues: (diff: string) => Promise<boolean>;
  /**
   * Ask "stop and restart daemon under <supervisor>?" — separate gate
   * from values-confirmation per the two-flag model.
   */
  readonly confirmRestart: (supervisor: Supervisor) => Promise<boolean>;
}

/**
 * Full options bag built by Commander callback. The callback is the
 * composition root: it instantiates `prompts` + `clock` and passes them in;
 * the orchestrator stays pure of process I/O.
 */
export interface OrchestratorOpts {
  /** Single-hint mode: the bare hint key. Undefined when --all. */
  readonly hintName?: string;
  /** Fill every stub-valued hint. */
  readonly all: boolean;
  /** Overwrite operator-filled hints. */
  readonly force: boolean;
  /** Bypass package-name shape validation (escape hatch). */
  readonly forceNoValidate: boolean;
  /** Print suggestion + diff, never touch daemon or file. */
  readonly dryRun: boolean;
  /** Skip values-confirmation prompt. */
  readonly yes: boolean;
  /** undefined = ask; true = --restart; false = --no-restart. */
  readonly restart: boolean | undefined;
  /** Override supervisor with manual stop+start command. */
  readonly restartCmd?: string;
  /** Resolved by the Commander callback. */
  readonly configPath: string;
  /** Resolved by the Commander callback (typically os.homedir()). */
  readonly homeDir: string;
  /** Disambiguate when both maps contain the same key. */
  readonly kindHint?: FillKind;
  /** Forwarded to /api/chat as `agentId`. */
  readonly agentId?: string;
  /** Captured from process.stdout.isTTY by the callback. */
  readonly isTty: boolean;
  /** Injected; tests pass vi.fn() shims. */
  readonly prompts: PromptIO;
  /** Injected; tests pin a fixed Date for determinism. */
  readonly clock: () => Date;
}

export interface OrchestratorResult {
  readonly exitCode: number;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Literal strings (anchored by anti-regression greps in integration tests)
// ---------------------------------------------------------------------------

export const TOOLFILL_2_GATEWAY_UNREACHABLE =
  "Cannot reach Comis daemon — gateway unreachable. Start the daemon and retry.";

export const TOOLFILL_4_YES_REQUIRED =
  "--yes required for non-interactive runs";

export const TOOLFILL_4_RESTART_REQUIRED =
  "--restart required for non-interactive runs";

export const TOOLFILL_9_VALIDATION_FAILED_PREFIX =
  "Validation failed; rolled back";

// ---------------------------------------------------------------------------
// Pipeline-stage hand-off types (internal — not re-exported from the barrel)
// ---------------------------------------------------------------------------

/** Result of the discover phase — one entry per hint to fill. */
export interface HintEntry {
  readonly name: string;
  readonly kind: FillKind;
  readonly current: HintShape;
  readonly mcpCommand?: string;
  readonly skillDescription?: string;
}

/** Result of the fill phase — one entry per hint successfully filled by the agent. */
export interface FilledEntry {
  readonly name: string;
  readonly kind: FillKind;
  readonly description: string;
  readonly replacesPackages: string[];
  readonly dropped: string[];
}

/** Result of the fill phase — one entry per hint skipped during --all. */
export interface SkippedEntry {
  readonly name: string;
  readonly reason: string;
}

/** Outcome of a rollback attempt — both legs reported separately so the
 * orchestrator can compose accurate operator-facing summaries. */
export interface RollbackOutcome {
  writeOk: boolean;
  startOk: boolean;
  writeError?: string;
  startError?: string;
}
