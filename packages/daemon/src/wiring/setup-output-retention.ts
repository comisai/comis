// SPDX-License-Identifier: Apache-2.0
/**
 * Output retention housekeeper: scans the agent's output/ directory,
 * deletes files whose age exceeds the per-class retentionMs.
 *
 * Mirrors setup-delivery.ts drain+prune timer pattern (single-tick gate +
 * unref() + structured DEBUG log per pass).
 *
 * Consumes JSONL details.visibleDelivery for offline analysis (the
 * housekeeper does NOT delete JSONL itself; it only manages output/
 * files referenced by it).
 *
 * Per AGENTS §2.2: NO `path.join`, NO `process.env`. All paths via
 *   `safePath(workspaceDir, ...)`. Per AGENTS §2.4: factory + Deps with
 *   ComisLogger injected. Per AGENTS §2.1: error paths log WARN/DEBUG with
 *   hint+errorKind; never throws. Per AGENTS §2.3 KISS: in-place file
 *   deletion. No "trash dir", no "soft delete". Per AGENTS §6.6
 *   (security/daemon): file deletion is destructive — operator can
 *   disable via `enabled: false` config.
 *
 * Test contract: `validateOutputRetentionConfig({ classes:
 * [{classId, retentionMs}] })` returns `{ ok, value | error }`.
 *
 * @module setup-output-retention
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import type { OutputRetentionConfig, RetentionClass } from "@comis/core";
import { safePath, systemNowMs, systemSetInterval, systemClearInterval } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { ok, err, suppressError, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SetupOutputRetentionDeps {
  /**
   * Validated config (from AppConfig.outputRetention). May be undefined
   * in legacy test mocks where AppConfig is hand-constructed via
   * `as unknown as`; the factory degrades to no-op in that case (mirrors
   * `setupDeliveryMirror`'s `if (!mirrorConfig?.enabled)` pattern).
   */
  config: OutputRetentionConfig | undefined;
  /** Absolute path to the workspace dir. The housekeeper scans `<workspaceDir>/output/`. */
  workspaceDir: string;
  /** Injected logger (per AGENTS §2.4 — never import @comis/infra at runtime). */
  logger: ComisLogger;
}

export interface SetupOutputRetentionHandle {
  /** Stop the recurring housekeeper interval. Idempotent. */
  shutdown(): void;
  /** Manual trigger for tests; runs one full pass synchronously. */
  runOnePass(): Promise<{ deleted: number; bytesFreed: number }>;
}

/**
 * Legacy array-of-objects shape preserved as the input to
 * `validateOutputRetentionConfig`. The housekeeper itself uses the
 * schema-derived `OutputRetentionConfig` (Record-of-classes shape); this
 * validator acts as the test's binding gate that retentionMs <= 0 is
 * rejected.
 */
export interface RetentionClassConfigInput {
  classId: string;
  retentionMs: number;
}

export interface ValidatedRetentionConfig {
  classes: RetentionClassConfigInput[];
}

// ---------------------------------------------------------------------------
// Validator (test contract gate)
// ---------------------------------------------------------------------------

/**
 * Validate an output-retention config supplied as the legacy
 * `{ classes: [{classId, retentionMs}] }` shape. Returns a Result-shaped
 * `{ ok: true, value }` on success, `{ ok: false, error }` on failure.
 *
 * Validator contract:
 *   - retentionMs = -1   → rejected
 *   - retentionMs = 0    → rejected
 *   - retentionMs = 1    → accepted
 *
 * Production wiring uses the Zod schema in
 * @comis/core/config/schema-output-retention.ts directly; this
 * validator is a thin compatibility surface for the test contract.
 */
export function validateOutputRetentionConfig(
  config: unknown,
): Result<ValidatedRetentionConfig, Error> {
  if (typeof config !== "object" || config === null) {
    return err(new Error("output retention config must be an object"));
  }
  const obj = config as { classes?: unknown };
  if (!Array.isArray(obj.classes)) {
    return err(new Error("output retention config: 'classes' must be an array"));
  }
  const out: RetentionClassConfigInput[] = [];
  for (let i = 0; i < obj.classes.length; i++) {
    const entry = obj.classes[i];
    if (typeof entry !== "object" || entry === null) {
      return err(
        new Error(`output retention config: classes[${i}] must be an object`),
      );
    }
    const e = entry as { classId?: unknown; retentionMs?: unknown };
    if (typeof e.classId !== "string" || e.classId.length === 0) {
      return err(
        new Error(
          `output retention config: classes[${i}].classId must be a non-empty string`,
        ),
      );
    }
    if (
      typeof e.retentionMs !== "number" ||
      !Number.isInteger(e.retentionMs) ||
      e.retentionMs <= 0
    ) {
      return err(
        new Error(
          `output retention config: classes[${i}].retentionMs must be a positive integer (got ${String(
            e.retentionMs,
          )})`,
        ),
      );
    }
    out.push({ classId: e.classId, retentionMs: e.retentionMs });
  }
  return ok({ classes: out });
}

// ---------------------------------------------------------------------------
// Housekeeper factory
// ---------------------------------------------------------------------------

/**
 * Wire the per-class output-retention housekeeper.
 *
 * Mirrors setup-delivery.ts (drain + prune timer): single-tick gate, .unref(),
 * structured per-pass log. The factory starts the recurring interval
 * immediately on construction; call shutdown() on system:shutdown.
 *
 * Returns a handle exposing `shutdown()` (idempotent) and `runOnePass()`
 * (manual trigger for tests).
 */
export function setupOutputRetention(
  deps: SetupOutputRetentionDeps,
): SetupOutputRetentionHandle {
  const log = deps.logger.child({ submodule: "output-retention-housekeeper" });

  // Defensive degradation: when config is undefined (legacy test mocks
  // bypassing the AppConfig schema via `as unknown as`), behave as if
  // disabled. Mirrors setupDeliveryMirror's optional-chain pattern.
  // Production paths get a fully-defaulted config from
  // AppConfigSchema.outputRetention, so this branch only triggers in
  // tests with hand-constructed config objects.
  if (!deps.config) {
    log.debug(
      {
        hint:
          "Output retention config not present; housekeeper inactive (likely a hand-constructed test mock)",
      },
      "Output retention: no config",
    );
    return {
      shutdown: () => {},
      runOnePass: async () => ({ deleted: 0, bytesFreed: 0 }),
    };
  }
  const config = deps.config;

  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;

  async function runOnePass(): Promise<{ deleted: number; bytesFreed: number }> {
    const outputDir = safePath(deps.workspaceDir, "output");
    const now = systemNowMs();
    let deleted = 0;
    let bytesFreed = 0;

    // Read class subdirectories under output/. Missing dir = nothing to do.
    let classDirs: string[];
    try {
      classDirs = readdirSync(outputDir);
    } catch {
      log.debug(
        { outputDir, hint: "Output dir missing — nothing to retain yet" },
        "Output retention: output dir not present",
      );
      return { deleted, bytesFreed };
    }

    for (const className of classDirs) {
      // Resolve class config: explicit class, else fall back to "default".
      const classConfig: RetentionClass | undefined =
        config.classes[className] ?? config.classes.default;
      if (!classConfig) continue;

      const classDir = safePath(outputDir, className);
      let entries: string[];
      try {
        entries = readdirSync(classDir);
      } catch (entryErr) {
        log.debug(
          {
            err: entryErr,
            classDir,
            hint: "Could not read class dir; will retry next pass",
            errorKind: "internal" as const,
          },
          "Output retention: class dir read failed",
        );
        continue;
      }

      for (const entry of entries) {
        const filePath = safePath(classDir, entry);
        try {
          const stats = statSync(filePath);
          // Skip subdirectories — only retain leaf files. Per KISS, no
          // recursion: each retention class is a single flat directory.
          if (!stats.isFile()) continue;
          const ageMs = now - stats.mtimeMs;
          if (ageMs > classConfig.retentionMs) {
            bytesFreed += stats.size;
            unlinkSync(filePath);
            deleted++;
          }
        } catch (fileErr) {
          log.debug(
            {
              err: fileErr,
              filePath,
              hint:
                "Failed to inspect/delete file in housekeeper pass; will retry next pass",
              errorKind: "internal" as const,
            },
            "Output retention: file inspect/delete failed",
          );
        }
      }
    }

    if (deleted > 0) {
      log.info(
        {
          deleted,
          bytesFreed,
          class: "output_retention",
          hint:
            "Per-class output retention completed; files older than configured retentionMs removed",
        },
        "Output retention: housekeeper pass completed",
      );
    } else {
      log.debug(
        { class: "output_retention", hint: "No files exceeded retentionMs this pass" },
        "Output retention: nothing to delete",
      );
    }

    return { deleted, bytesFreed };
  }

  function startInterval(): void {
    if (!config.enabled) {
      log.info(
        { hint: "Output retention disabled by config; not starting housekeeper" },
        "Output retention: disabled",
      );
      return;
    }
    interval = systemSetInterval(() => {
      // Single-tick gate: in-flight Promise prevents overlapping ticks.
      if (running) return;
      running = runOnePass()
        .then(() => undefined)
        .finally(() => {
          running = null;
        });
      // Fire-and-forget: failures inside runOnePass are already logged
      // and do not propagate (it never throws). suppressError satisfies
      // the no-floating-promise lint without altering semantics.
      suppressError(running, "output retention recurring tick");
    }, config.intervalMs);
    interval.unref();
    log.info(
      {
        intervalMs: config.intervalMs,
        classes: Object.keys(config.classes),
        hint: "Output retention housekeeper started",
      },
      "Output retention: started",
    );
  }

  function shutdown(): void {
    if (interval) {
      systemClearInterval(interval);
      interval = undefined;
    }
  }

  // Start immediately on construction (mirrors setup-delivery's startup pattern).
  startInterval();

  return { shutdown, runOnePass };
}
