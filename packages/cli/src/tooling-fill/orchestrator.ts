// SPDX-License-Identifier: Apache-2.0
/**
 * `comis config tooling-fill` orchestrator — the load-bearing state
 * machine that composes the helpers into the product surface.
 *
 * State sequence:
 *
 *  1. Resolve hint(s) to fill — load config, parseDocument, list candidates.
 *     Single hint: `--kindHint mcp|skills` disambiguates name collisions.
 *     `--all`: every stub-valued hint across both maps (operator-filled
 *     hints are skipped silently).
 *  2. Pre-flight daemon-up check — `isDaemonRunning()` MUST be true for
 *     the LLM call. On failure exit 1 with the gateway-unreachable string
 *     and DO NOT touch config.yaml.
 *  3. Resolve gateway port + token from configJs (port) +
 *     loadEnvFile($HOME/.comis/.env) → COMIS_GATEWAY_TOKEN env reference.
 *     Token resolution mirrors rpc-client.ts:resolveEnvRef so the same
 *     `${VAR}` pattern lands on the same value.
 *  4. Resolve supervisor — `--restart-cmd` overrides; else
 *     detectSupervisor(); `kind:"none"` AND not dry-run → exit 1 with
 *     MANUAL_RECIPE_HINT.
 *  5. For each hint:
 *     a. buildFillPrompt → callAgent → parseFillResponse → validatePackageNames
 *     b. all-dropped (≠0 in, 0 out) AND not --force-no-validate → exit 1
 *        as agent failure.
 *     c. Idempotency: !isStubValued(currentHint) AND !force →
 *        exit 1 with the idempotency-refusal string (see source for the
 *        literal).
 *  6. --dry-run short-circuit: print suggestion + diff, exit 0. NEVER
 *     stop daemon. NEVER touch file.
 *  7. Confirmation prompt (values): if !yes && isTty →
 *     prompts.confirmValues(diff). Non-TTY without --yes → exit 1 with
 *     the yes-required string.
 *  8. Restart-authorization prompt: if restart===undefined && isTty →
 *     prompts.confirmRestart(supervisor). Non-TTY without --restart →
 *     exit 1 with the restart-required string. With --no-restart: write
 *     the file but skip stop+start (warn that operator must restart
 *     manually).
 *  9. **Protected mutation window**:
 *     a. stopDaemon — bail with err if it fails (do NOT proceed).
 *     b. writeBackup(configPath, homeDir, "tooling-fill") — backup-fail
 *        → restart daemon best-effort + exit 2.
 *     c. setHintFields per entry → if any fails → restore backup +
 *        start daemon + exit 1.
 *     d. atomicWriteFile(configPath, doc.toString()) — write-fail →
 *        restore + start daemon + exit 2.
 *     e. validateConfig(loadConfigFile(configPath).value) — validate-fail
 *        → restore (atomicWriteFile original raw), start daemon, exit 1
 *        with the rollback string.
 * 10. startDaemon — best-effort warn-and-continue on failure.
 * 11. Success: exitCode=0, summary lists filled hints + backup path.
 *
 * Returns `{exitCode, summary}` — Commander callback owns stdout/stderr.
 *
 * @module
 */

import * as fs from "node:fs";
import { parseDocument, isMap, isPair, isScalar, type Document } from "yaml";
import { ok, err, type Result } from "@comis/shared";
import { loadConfigFile, loadEnvFile, systemGetEnv, validateConfig } from "@comis/core";
import { callAgent } from "./agent-call.js";
import {
  detectSupervisor,
  stopDaemon,
  startDaemon,
  waitForDaemonAlive,
  MANUAL_RECIPE_HINT,
  type Supervisor,
} from "./supervisor.js";
import { buildFillPrompt } from "./prompt-template.js";
import { parseFillResponse } from "./response-parser.js";
import {
  isStubValued,
  validatePackageNames,
  type HintShape,
} from "./validators.js";
import { setHintFields, type FillKind } from "./apply-hint.js";
import {
  atomicWriteFile,
  writeBackup,
  pruneOldBackups,
  isDaemonRunning,
} from "../sync-tooling/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Operator interactions are injected — testable without a real TTY.
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
 * composition root (AGENTS.md §2.4): it instantiates `prompts` + `clock`
 * and passes them in; the orchestrator stays pure of process I/O.
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
// Literal strings — anchored by anti-regression greps.
// ---------------------------------------------------------------------------

const TOOLFILL_2_GATEWAY_UNREACHABLE =
  "Cannot reach Comis daemon — gateway unreachable. Start the daemon and retry.";

const TOOLFILL_4_YES_REQUIRED =
  "--yes required for non-interactive runs";

const TOOLFILL_4_RESTART_REQUIRED =
  "--restart required for non-interactive runs";

const TOOLFILL_9_VALIDATION_FAILED_PREFIX = "Validation failed; rolled back";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HintEntry {
  readonly name: string;
  readonly kind: FillKind;
  readonly current: HintShape;
  readonly mcpCommand?: string;
  readonly skillDescription?: string;
}

interface FilledEntry {
  readonly name: string;
  readonly kind: FillKind;
  readonly description: string;
  readonly replacesPackages: string[];
  readonly dropped: string[];
}

interface SkippedEntry {
  readonly name: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

/**
 * Top-level entry. Always resolves a `{exitCode, summary}` — never throws
 * (per AGENTS.md §2.1; orchestrator catches Result errors internally).
 */
export async function runToolingFill(
  opts: OrchestratorOpts,
): Promise<OrchestratorResult> {
  // ---- Validate args ----------------------------------------------------
  if (!opts.all && opts.hintName === undefined) {
    return {
      exitCode: 1,
      summary:
        "<hint-name> is required unless --all is passed.",
    };
  }

  // ---- Load config (raw + JS view + AST) -------------------------------
  let rawYaml: string;
  try {
    rawYaml = fs.readFileSync(opts.configPath, "utf-8");
  } catch (e) {
    return {
      exitCode: 1,
      summary: `Failed to read ${opts.configPath}: ${(e as Error).message}`,
    };
  }

  const loaded = loadConfigFile(opts.configPath);
  if (!loaded.ok) {
    return {
      exitCode: 1,
      summary: `Failed to load ${opts.configPath}: ${loaded.error.message}`,
    };
  }
  const configJs = loaded.value as Record<string, unknown>;

  let doc: Document;
  try {
    doc = parseDocument(rawYaml);
    if (doc.errors.length > 0) {
      return {
        exitCode: 1,
        summary: `Invalid YAML in ${opts.configPath}: ${doc.errors
          .map((er) => er.message)
          .join("; ")}`,
      };
    }
  } catch (e) {
    return {
      exitCode: 1,
      summary: `Failed to parse ${opts.configPath}: ${String(e)}`,
    };
  }

  // ---- Resolve hint(s) to fill -----------------------------------------
  const resolved = resolveHints(doc, opts);
  if (!resolved.ok) {
    return { exitCode: 1, summary: resolved.error };
  }
  let entries = resolved.value;

  // For --all: filter to stub-valued unless --force.
  if (opts.all && !opts.force) {
    entries = entries.filter((e) => isStubValued(e.current));
  }

  if (entries.length === 0) {
    return {
      exitCode: 0,
      summary: opts.all
        ? "(nothing to fill — no stub-valued hints found)"
        : "(nothing to fill)",
    };
  }

  // ---- Idempotency check (single-hint mode) ----------------------------
  // For single-hint mode, refuse if non-stub AND not --force. (--all does
  // its own silent skip above.)
  if (!opts.all && !opts.force) {
    const onlyEntry = entries[0]!;
    if (!isStubValued(onlyEntry.current)) {
      const desc = onlyEntry.current.description ?? "";
      const pkgs = onlyEntry.current.replacesPackages ?? [];
      return {
        exitCode: 1,
        summary: `${onlyEntry.name}: already filled (description: "${desc}", replacesPackages: [${pkgs.length} items]). Use --force to overwrite.`,
      };
    }
  }

  // ---- Pre-flight: daemon must be UP for the LLM call -----------------
  const daemonUp = await isDaemonRunning();
  if (!daemonUp) {
    return {
      exitCode: 1,
      summary: TOOLFILL_2_GATEWAY_UNREACHABLE,
    };
  }

  // ---- Resolve gateway port + token ------------------------------------
  // loadEnvFile mutates the environment; the caller's env will pick
  // up COMIS_GATEWAY_TOKEN if it's referenced in the config as ${VAR}.
  loadEnvFile(`${opts.homeDir}/.comis/.env`);
  const portToken = resolveGatewayConn(configJs);
  if (!portToken.ok) {
    return { exitCode: 1, summary: portToken.error };
  }
  const { port, token } = portToken.value;

  // ---- Resolve supervisor ----------------------------------------------
  let supervisor: Supervisor;
  if (opts.restartCmd !== undefined && opts.restartCmd.length > 0) {
    supervisor = { kind: "manual", cmd: opts.restartCmd };
  } else {
    supervisor = await detectSupervisor();
  }
  // For dry-run, supervisor.kind === "none" is OK — we don't need to stop
  // the daemon. With --no-restart the operator explicitly declines the
  // restart leg, so a missing supervisor is also fine.
  // Otherwise surface MANUAL_RECIPE_HINT.
  if (supervisor.kind === "none" && !opts.dryRun && opts.restart !== false) {
    return {
      exitCode: 1,
      summary: MANUAL_RECIPE_HINT,
    };
  }

  // ---- Non-TTY gates (fail-fast BEFORE the LLM call) ------------------
  // The agent call is the expensive step; if we know we cannot confirm
  // (non-TTY without --yes) or cannot restart (non-TTY without --restart
  // or --no-restart), exit immediately so we don't burn an LLM round-trip.
  // Dry-run skips both gates (no confirmation required for a no-op run).
  if (!opts.dryRun) {
    if (!opts.yes && !opts.isTty) {
      return { exitCode: 1, summary: TOOLFILL_4_YES_REQUIRED };
    }
    if (opts.restart === undefined && !opts.isTty) {
      return { exitCode: 1, summary: TOOLFILL_4_RESTART_REQUIRED };
    }
  }

  // ---- For each hint: callAgent → parse → validate ---------------------
  const filled: FilledEntry[] = [];
  const skipped: SkippedEntry[] = [];
  let agentFailureFatal = false;
  let agentFailureMessage = "";

  // Test-only fault injector: when set, use the env value as the literal
  // agent response instead of POSTing to /api/chat. Gated on a test-runtime
  // signal (NODE_ENV or VITEST) — fails LOUD if set in a production
  // environment so a poisoned ~/.comis/.env cannot silently substitute
  // attacker-controlled description/replacesPackages values into config.
  // AGENTS.md §2.2 lists "test fault injectors" as an exception to the
  // no-runtime-env rule.
  const testAgentResponseRaw = systemGetEnv("COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE");
  const isTestRuntime = systemGetEnv("NODE_ENV") === "test" || systemGetEnv("VITEST") === "true";
  if (testAgentResponseRaw !== undefined && !isTestRuntime) {
    return {
      exitCode: 1,
      summary:
        "COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE is a test-only fault injector and must not be set in production. Unset it and retry.",
    };
  }
  const testAgentResponse = testAgentResponseRaw;

  for (const entry of entries) {
    const prompt = buildFillPrompt({
      kind: entry.kind,
      name: entry.name,
      mcpCommand: entry.mcpCommand,
      skillDescription: entry.skillDescription,
      currentDescription:
        entry.current.description !== undefined &&
        entry.current.description !== "TODO" &&
        entry.current.description !== ""
          ? entry.current.description
          : undefined,
    });

    const callRes =
      testAgentResponse !== undefined
        ? ok({ response: testAgentResponse })
        : await callAgent({
            port,
            token,
            prompt,
            agentId: opts.agentId,
            timeoutMs: 30_000,
          });
    if (!callRes.ok) {
      // Single-hint: bail with exit 1 immediately.
      // --all: record skip and continue to next hint (partial success:
      // previously-filled hints stay committed).
      const msg = `${callRes.error.kind}: ${callRes.error.message}`;
      if (opts.all) {
        skipped.push({ name: entry.name, reason: callRes.error.kind });
        continue;
      }
      return { exitCode: 1, summary: `Agent call failed for ${entry.name}: ${msg}` };
    }

    const parsed = parseFillResponse(callRes.value.response);
    if (!parsed.ok) {
      const msg = `parse failure: ${parsed.error.reason}`;
      if (opts.all) {
        skipped.push({ name: entry.name, reason: msg });
        continue;
      }
      return {
        exitCode: 1,
        summary: `Agent response invalid for ${entry.name}: ${msg}`,
      };
    }

    const validated = validatePackageNames(parsed.value.replacesPackages);
    const allDropped =
      parsed.value.replacesPackages.length > 0 &&
      validated.valid.length === 0;
    if (allDropped && !opts.forceNoValidate) {
      const msg = `all package names invalid (dropped: ${validated.dropped.join(", ")})`;
      if (opts.all) {
        skipped.push({ name: entry.name, reason: msg });
        continue;
      }
      agentFailureFatal = true;
      agentFailureMessage = `Agent emitted no valid package names for ${entry.name}: ${validated.dropped.join(", ")}`;
      break;
    }

    filled.push({
      name: entry.name,
      kind: entry.kind,
      description: parsed.value.description,
      replacesPackages: validated.valid,
      dropped: validated.dropped,
    });
  }

  if (agentFailureFatal) {
    return { exitCode: 1, summary: agentFailureMessage };
  }

  if (filled.length === 0) {
    // All entries skipped (only possible with --all + agent failures).
    const skippedReport = skipped
      .map((s) => `${s.name} (${s.reason})`)
      .join(", ");
    return {
      exitCode: 1,
      summary: `All hints skipped: ${skippedReport}`,
    };
  }

  // ---- Build the diff string for dry-run / confirmation ----------------
  const diffString = renderFillDiff(filled, entries);

  // ---- Dry-run short-circuit ------------------------------------------
  if (opts.dryRun) {
    return {
      exitCode: 0,
      summary: `[dry-run] Would fill ${filled.length} hint(s):\n${diffString}`,
    };
  }

  // ---- Confirmation prompt (values) -----------------------------------
  if (!opts.yes) {
    if (!opts.isTty) {
      return { exitCode: 1, summary: TOOLFILL_4_YES_REQUIRED };
    }
    const okValues = await opts.prompts.confirmValues(diffString);
    if (!okValues) {
      return { exitCode: 0, summary: "aborted by operator" };
    }
  }

  // ---- Restart authorization prompt -----------------------------------
  let willRestart: boolean;
  if (opts.restart === false) {
    // --no-restart explicit: write file but skip stop+start.
    willRestart = false;
  } else if (opts.restart === true) {
    willRestart = true;
  } else {
    // restart === undefined → must prompt or fail (non-TTY).
    if (!opts.isTty) {
      return { exitCode: 1, summary: TOOLFILL_4_RESTART_REQUIRED };
    }
    const okRestart = await opts.prompts.confirmRestart(supervisor);
    if (!okRestart) {
      // Operator-driven aborts exit 0 (matches values-decline). Shell
      // scripts that distinguish "user said no" from "command failed"
      // expect a clean exit on either prompt.
      return { exitCode: 0, summary: "operator declined daemon restart" };
    }
    willRestart = true;
  }

  // ---- Protected mutation window --------------------------------------
  // 9a. stopDaemon
  if (willRestart) {
    const stopRes = await stopDaemon(supervisor);
    if (!stopRes.ok) {
      return {
        exitCode: 1,
        summary: `Failed to stop daemon: ${stopRes.error.message}`,
      };
    }
  }

  // 9b. writeBackup
  const backupRes = writeBackup(opts.configPath, opts.homeDir, "tooling-fill");
  if (!backupRes.ok) {
    // Best-effort restart, then exit 2.
    if (willRestart) {
      await startDaemon(supervisor);
    }
    return {
      exitCode: 2,
      summary: `Backup failed (${backupRes.error.code}): ${backupRes.error.path} — ${backupRes.error.cause}`,
    };
  }
  const backupPath = backupRes.value.backupPath;

  // 9c. setHintFields per entry — accumulate into doc.
  for (const entry of filled) {
    const applyRes = setHintFields(doc, entry.kind, entry.name, {
      description: entry.description,
      replacesPackages: entry.replacesPackages,
    });
    if (!applyRes.ok) {
      // Restore from backup + restart.
      const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
      return {
        exitCode: rb.writeOk && rb.startOk ? 1 : 2,
        summary: `setHintFields failed for ${entry.name}: ${applyRes.error.kind} (${applyRes.error.path}). ${rolledBackSuffix(backupPath, opts.configPath, rb)}`,
      };
    }
  }

  // 9d. atomicWriteFile
  const writeRes = atomicWriteFile(opts.configPath, doc.toString());
  if (!writeRes.ok) {
    const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
    return {
      exitCode: 2,
      summary: `Atomic write failed (${writeRes.error.code}): ${writeRes.error.cause}. ${rolledBackSuffix(backupPath, opts.configPath, rb)}`,
    };
  }

  // 9e. validateConfig — re-load + validate the freshly written file.
  // Env-substitute `${VAR}` references before validation, mirroring
  // `comis config validate` (commands/config.ts:131-133). Without this, any
  // config using the documented `${COMIS_GATEWAY_TOKEN}` pattern would fail
  // Zod's `z.string().min(32)` on the literal `${...}` (22 chars) and trigger
  // a false-positive rollback on every successful run.
  const reloaded = loadConfigFile(opts.configPath);
  if (!reloaded.ok) {
    const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
    return {
      exitCode: rb.writeOk && rb.startOk ? 1 : 2,
      summary: rolledBackSummary(
        backupPath,
        opts.configPath,
        rb,
        `Reload error: ${reloaded.error.message}`,
      ),
    };
  }
  resolveEnvRefs(reloaded.value);
  const validation = validateConfig(reloaded.value);
  if (!validation.ok) {
    const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
    return {
      exitCode: rb.writeOk && rb.startOk ? 1 : 2,
      summary: rolledBackSummary(backupPath, opts.configPath, rb, undefined),
    };
  }

  // ---- 10. startDaemon + verify-alive ---------------------------------
  // `systemctl start` exits 0 once the unit is queued, not once the daemon
  // has finished booting. If the daemon then crashes during boot (e.g.
  // misowned config, invalid YAML), the orchestrator was previously a
  // false-positive on success. Poll isDaemonRunning() for up to 15s after
  // the start command; if the daemon doesn't come up, restore the backup
  // and try again — never leave the operator with a dead daemon and a
  // "success" message.
  if (willRestart) {
    const startRes = await startDaemon(supervisor);
    if (!startRes.ok) {
      const filledNames = filled.map((f) => f.name).join(", ");
      const droppedReport = renderDroppedReport(filled);
      const skippedReport = renderSkippedReport(skipped);
      return {
        exitCode: 0,
        summary: `Filled ${filled.length} hint(s): ${filledNames}.${droppedReport}${skippedReport} Backup: ${backupPath}. WARNING: daemon failed to restart: ${startRes.error.message}`,
      };
    }
    // Liveness verification: poll until the gateway answers /api/system.ping
    // or we hit the timeout.
    const aliveRes = await waitForDaemonAlive(isDaemonRunning);
    if (!aliveRes.ok) {
      // Daemon didn't come up. Try to restore the backup and restart.
      // Whether or not that succeeds, we exit non-zero.
      const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
      const filledNames = filled.map((f) => f.name).join(", ");
      return {
        exitCode: 2,
        summary: `Daemon failed to come up after start (${aliveRes.error.message}). Filled hints (${filledNames}) were rolled back to ${backupPath}. ${rolledBackSuffix(backupPath, opts.configPath, rb)}`,
      };
    }
  }

  // ---- 11. Partial success on --all -----------------------------------
  if (skipped.length > 0) {
    const filledNames = filled.map((f) => f.name).join(", ");
    const skippedReport = skipped
      .map((s) => `${s.name} (${s.reason})`)
      .join(", ");
    const droppedReport = renderDroppedReport(filled);
    return {
      exitCode: 1,
      summary: `Filled: ${filledNames}.${droppedReport} Skipped: ${skippedReport}. Backup: ${backupPath}.`,
    };
  }

  // ---- 12. Backup retention -------------------------------------------
  // Keep the 5 most recent tooling-fill backups, drop older. Best-effort —
  // never failing the success path on a housekeeping miss.
  const pruneRes = pruneOldBackups(opts.homeDir, "tooling-fill", 5);
  const pruneSuffix = pruneRes.deleted > 0 ? ` (pruned ${pruneRes.deleted} older backup(s))` : "";

  // ---- 13. Success exit ------------------------------------------------
  const filledNames = filled.map((f) => f.name).join(", ");
  const droppedReport = renderDroppedReport(filled);
  return {
    exitCode: 0,
    summary: `Filled ${filled.length} hint(s): ${filledNames}.${droppedReport} Backup: ${backupPath}.${pruneSuffix}`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Inspect both `tooling.mcp.capabilityHints` and `tooling.skills.capabilityHints`
 * and produce the list of hints to operate on.
 *
 * Single-hint mode: resolves <name> via map containment. If both maps
 * contain the key, requires `--kind` (returns err otherwise).
 *
 * --all mode: every hint across both maps. Idempotency filtering happens
 * downstream (caller filters by isStubValued unless --force).
 */
function resolveHints(
  doc: Document,
  opts: OrchestratorOpts,
): Result<HintEntry[], string> {
  const mcpHints = readHintMap(doc, ["tooling", "mcp", "capabilityHints"]);
  const skillHints = readHintMap(doc, [
    "tooling",
    "skills",
    "capabilityHints",
  ]);
  const mcpCommands = readMcpCommands(doc);
  const skillDescriptions = readSkillDescriptions(doc);

  if (opts.all) {
    const out: HintEntry[] = [];
    for (const [name, hint] of mcpHints) {
      out.push({
        name,
        kind: "mcp",
        current: hint,
        mcpCommand: mcpCommands.get(name),
      });
    }
    for (const [name, hint] of skillHints) {
      out.push({
        name,
        kind: "skills",
        current: hint,
        skillDescription: skillDescriptions.get(name),
      });
    }
    return ok(out);
  }

  const name = opts.hintName!;
  const inMcp = mcpHints.has(name);
  const inSkills = skillHints.has(name);
  if (!inMcp && !inSkills) {
    return err(
      `Hint not found: "${name}". Run "comis config sync-tooling --write" first to materialize the stub.`,
    );
  }
  let kind: FillKind;
  if (opts.kindHint !== undefined) {
    kind = opts.kindHint;
    if (kind === "mcp" && !inMcp) {
      return err(`Hint "${name}" not found under tooling.mcp.capabilityHints`);
    }
    if (kind === "skills" && !inSkills) {
      return err(
        `Hint "${name}" not found under tooling.skills.capabilityHints`,
      );
    }
  } else if (inMcp && inSkills) {
    return err(
      `Ambiguous hint name "${name}" — present under both mcp and skills. Pass --kind mcp|skills to disambiguate.`,
    );
  } else {
    kind = inMcp ? "mcp" : "skills";
  }

  const current = (kind === "mcp" ? mcpHints : skillHints).get(name)!;
  if (kind === "mcp") {
    return ok([{ name, kind, current, mcpCommand: mcpCommands.get(name) }]);
  }
  return ok([
    { name, kind, current, skillDescription: skillDescriptions.get(name) },
  ]);
}

/**
 * Read a YAMLMap of capabilityHints into a Map<name, HintShape>.
 *
 * Each value is reduced to {description?, replacesPackages?} — the two
 * fields the orchestrator needs to call isStubValued. Other fields
 * (cluster, future fields) are not surfaced here; setHintFields touches
 * them via doc.setIn at known paths.
 */
function readHintMap(
  doc: Document,
  hintMapPath: string[],
): Map<string, HintShape> {
  const out = new Map<string, HintShape>();
  if (!doc.hasIn(hintMapPath)) return out;
  const node = doc.getIn(hintMapPath, true);
  if (!isMap(node)) return out;
  for (const p of node.items) {
    if (!isPair(p)) continue;
    const k = isScalar(p.key) ? p.key.value : p.key;
    if (typeof k !== "string") continue;
    const valueNode = p.value;
    if (!isMap(valueNode)) {
      out.set(k, {});
      continue;
    }
    const desc = readScalarString(valueNode, "description");
    const pkgs = readSeqStrings(valueNode, "replacesPackages");
    out.set(k, {
      description: desc,
      replacesPackages: pkgs,
    });
  }
  return out;
}

/** Read a string scalar from a YAMLMap by key, or undefined if absent/non-string. */
function readScalarString(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- yaml@2.8.4 YAMLMap doesn't expose a public type-narrowing helper for this lookup.
  mapNode: any,
  key: string,
): string | undefined {
  if (!mapNode || typeof mapNode.get !== "function") return undefined;
  const v = mapNode.get(key, true) as unknown;
  if (v === undefined || v === null) return undefined;
  if (isScalar(v)) {
    return typeof v.value === "string" ? v.value : undefined;
  }
  return typeof v === "string" ? v : undefined;
}

/** Read a YAMLSeq of strings from a YAMLMap by key, or undefined if absent. */
function readSeqStrings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- yaml@2.8.4 YAMLMap.
  mapNode: any,
  key: string,
): string[] | undefined {
  if (!mapNode || typeof mapNode.get !== "function") return undefined;
  const v = mapNode.get(key) as unknown;
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return undefined;
}

/**
 * Read `integrations.mcp.servers` and produce a name → "command args..."
 * map for prompt context. Best-effort — silent on malformed entries.
 */
function readMcpCommands(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  const node = doc.getIn(["integrations", "mcp", "servers"], true);
  if (node === undefined || node === null) return out;
  // Use doc.toJSON() at the path for simplicity — not performance-critical.
  const js = doc.getIn(["integrations", "mcp", "servers"]) as unknown;
  if (!Array.isArray(js)) return out;
  for (const srv of js) {
    if (typeof srv !== "object" || srv === null) continue;
    const s = srv as { name?: unknown; command?: unknown; args?: unknown };
    if (typeof s.name !== "string") continue;
    const cmd =
      typeof s.command === "string"
        ? `${s.command}${
            Array.isArray(s.args)
              ? " " + s.args.filter((a) => typeof a === "string").join(" ")
              : ""
          }`
        : undefined;
    if (cmd !== undefined) out.set(s.name, cmd);
  }
  return out;
}

/**
 * Read existing skill manifest descriptions for prompt context. Skills are
 * harder to introspect than MCPs because they live on disk; for the
 * orchestrator's prompt we only need the manifest description if it's
 * already laid down in the existing capability hint (the operator hasn't
 * stubbed it back to TODO yet). For full skills introspection see
 * sync-tooling/discover.ts.
 */
function readSkillDescriptions(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  const hints = readHintMap(doc, ["tooling", "skills", "capabilityHints"]);
  for (const [name, h] of hints) {
    if (
      typeof h.description === "string" &&
      h.description !== "TODO" &&
      h.description !== ""
    ) {
      out.set(name, h.description);
    }
  }
  return out;
}

/**
 * Resolve gateway port + token from configJs, expanding `${VAR}` refs in
 * the token via the runtime environment (the same precedence chain as
 * the daemon).
 *
 * Two supported token shapes (in precedence order):
 *  1. `gateway.token: <string>`         — convenience shape used by the
 *                                         orchestrator's unit-test fixtures
 *                                         (one-line YAML; no scopes).
 *  2. `gateway.tokens[0].secret: <string>` — the canonical production schema
 *                                            (`packages/core/src/config/schema-gateway.ts`):
 *                                            `tokens` is an array of
 *                                            `{id, secret, scopes}`. The first
 *                                            entry's secret is used so the
 *                                            CLI hits /api/chat with a
 *                                            valid bearer.
 *
 * Both shapes accept `${VAR}` env-substitution; the same expansion rule
 * applies to whichever shape resolves to a non-empty string first.
 *
 * Per AGENTS.md §2.2 the runtime env read is the documented exception:
 * CLI bootstrap before SecretManager is loaded.
 */
function resolveGatewayConn(
  configJs: Record<string, unknown>,
): Result<{ port: number; token: string }, string> {
  const gateway = configJs["gateway"] as Record<string, unknown> | undefined;
  if (!gateway || typeof gateway !== "object") {
    return err(
      "gateway.port not configured — cannot reach the daemon's /api/chat",
    );
  }
  const port = gateway["port"];
  if (typeof port !== "number" || port <= 0) {
    return err(
      `gateway.port not configured — cannot reach the daemon's /api/chat (got: ${String(port)})`,
    );
  }

  // Shape 1: convenience `gateway.token: <string>`.
  let tokenRaw: string | undefined;
  const directToken = gateway["token"];
  if (typeof directToken === "string" && directToken.length > 0) {
    tokenRaw = directToken;
  } else {
    // Shape 2: canonical `gateway.tokens[0].secret: <string>` (production
    // schema). The CLI uses the FIRST entry — it is the daemon's primary
    // bearer per the schema's documented convention. Operators with
    // multi-token deployments who want the CLI to use a non-first token
    // should override via COMIS_GATEWAY_TOKEN-style env-substitution
    // inside the first entry's `secret` field, NOT by reordering the array.
    const tokensArr = gateway["tokens"];
    if (Array.isArray(tokensArr) && tokensArr.length > 0) {
      const first = tokensArr[0] as { secret?: unknown } | null | undefined;
      if (first && typeof first === "object") {
        const secret = first.secret;
        if (typeof secret === "string" && secret.length > 0) {
          tokenRaw = secret;
        }
      }
    }
  }

  if (tokenRaw === undefined) {
    return err(
      "gateway.token not configured — set COMIS_GATEWAY_TOKEN in ~/.comis/.env",
    );
  }

  // Expand `${VAR}` if the value is a single-var reference.
  const m = tokenRaw.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
  let resolvedToken: string;
  if (m !== null) {
    const fromEnv = systemGetEnv(m[1]!);
    if (fromEnv === undefined || fromEnv.length === 0) {
      return err(
        `gateway.token references \${${m[1]!}} but it is not set — check ~/.comis/.env`,
      );
    }
    resolvedToken = fromEnv;
  } else {
    resolvedToken = tokenRaw;
  }
  return ok({ port, token: resolvedToken });
}

/**
 * Render the suggested-vs-current diff for dry-run / confirmation.
 *
 * Format (one block per hint):
 *   <kind>.<name>:
 *     description: "<current>" → "<new>"
 *     replacesPackages: [<current>] → [<new>]
 */
function renderFillDiff(
  filled: FilledEntry[],
  entries: HintEntry[],
): string {
  const blocks: string[] = [];
  for (const f of filled) {
    const cur = entries.find(
      (e) => e.name === f.name && e.kind === f.kind,
    )!.current;
    const curDesc = cur.description ?? "";
    const curPkgs = cur.replacesPackages ?? [];
    blocks.push(
      `${f.kind}.${f.name}:\n` +
        `  description: "${curDesc}" → "${f.description}"\n` +
        `  replacesPackages: [${curPkgs.join(", ")}] → [${f.replacesPackages.join(", ")}]`,
    );
  }
  return blocks.join("\n\n");
}

/** Append "(dropped N invalid package name(s): …)" to summary if any. */
function renderDroppedReport(filled: FilledEntry[]): string {
  const total = filled.reduce((acc, f) => acc + f.dropped.length, 0);
  if (total === 0) return "";
  const allDropped = filled.flatMap((f) => f.dropped);
  return ` (dropped ${total} invalid package name(s): ${allDropped.join(", ")})`;
}

/** Append "Skipped: name (reason), …" to summary if any. */
function renderSkippedReport(skipped: SkippedEntry[]): string {
  if (skipped.length === 0) return "";
  const report = skipped.map((s) => `${s.name} (${s.reason})`).join(", ");
  return ` Skipped: ${report}.`;
}

/** Outcome of a rollback attempt — both legs reported separately so the
 * orchestrator can compose accurate operator-facing summaries. */
interface RollbackOutcome {
  writeOk: boolean;
  startOk: boolean;
  writeError?: string;
  startError?: string;
}

/**
 * Restore the backup (atomically write the original raw YAML back) and
 * restart the daemon best-effort. Returns separate flags for write + start
 * so the caller can warn about partial-rollback states.
 */
async function rollback(
  configPath: string,
  originalRawYaml: string,
  willRestart: boolean,
  supervisor: Supervisor,
): Promise<RollbackOutcome> {
  const writeRes = atomicWriteFile(configPath, originalRawYaml);
  let startOk = true;
  let startError: string | undefined;
  if (willRestart) {
    const startRes = await startDaemon(supervisor);
    startOk = startRes.ok;
    if (!startRes.ok) startError = startRes.error.message;
  }
  return {
    writeOk: writeRes.ok,
    startOk,
    writeError: writeRes.ok ? undefined : writeRes.error.cause,
    startError,
  };
}

/** Compose the standard `Validation failed; rolled back …` summary, honestly
 * reflecting any partial-rollback failure. */
function rolledBackSummary(
  backupPath: string,
  configPath: string,
  rb: RollbackOutcome,
  extra: string | undefined,
): string {
  if (!rb.writeOk) {
    return `${TOOLFILL_9_VALIDATION_FAILED_PREFIX} to ${backupPath}. ROLLBACK FAILED: could not restore (${rb.writeError ?? "unknown"}). Manual recovery required: cp ${backupPath} ${configPath}.${extra ? ` ${extra}` : ""}`;
  }
  if (!rb.startOk) {
    return `${TOOLFILL_9_VALIDATION_FAILED_PREFIX} to ${backupPath}. File restored but daemon FAILED TO RESTART (${rb.startError ?? "unknown"}). Restart manually.${extra ? ` ${extra}` : ""}`;
  }
  return `${TOOLFILL_9_VALIDATION_FAILED_PREFIX} to ${backupPath}. Original daemon state restored.${extra ? ` ${extra}` : ""}`;
}

/** Compact rollback-state suffix appended to non-validation error summaries. */
function rolledBackSuffix(
  backupPath: string,
  configPath: string,
  rb: RollbackOutcome,
): string {
  if (!rb.writeOk) {
    return `ROLLBACK FAILED — manual recovery: cp ${backupPath} ${configPath}.`;
  }
  if (!rb.startOk) {
    return `Rolled back to ${backupPath} but daemon FAILED TO RESTART (${rb.startError ?? "unknown"}). Restart manually.`;
  }
  return `Rolled back to ${backupPath}. Original daemon state restored.`;
}

/** Pattern matching `${VAR_NAME}` env var references — mirrors the same
 * pattern in commands/config.ts:resolveEnvRefs. */
const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Deep-walk an object and resolve `${VAR}` references using process.env.
 * Mutates in place. Mirrors `commands/config.ts:resolveEnvRefs` so the
 * post-write `validateConfig` call sees the same substituted shape that
 * `comis config validate` would. Without this, configs using the documented
 * `${COMIS_GATEWAY_TOKEN}` pattern fail Zod's min(32) check on the literal
 * `${...}` (22 chars) and trigger a false-positive rollback.
 */
function resolveEnvRefs(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.includes("${")) {
      obj[key] = value.replace(ENV_REF_RE, (match, varName: string) => {
        return systemGetEnv(varName) ?? match;
      });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      resolveEnvRefs(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          resolveEnvRefs(item as Record<string, unknown>);
        }
      }
    }
  }
}
