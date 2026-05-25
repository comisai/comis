// SPDX-License-Identifier: Apache-2.0
/**
 * Fill phase of `comis config tooling-fill`.
 *
 * Pre-flight: daemon-up check, gateway port + token resolution, supervisor
 * detection, non-TTY fail-fast gates. Per-hint: callAgent → parseFillResponse
 * → validatePackageNames; --all skips per failure, single-hint bails.
 *
 * Returns a `FillOutcome` with either a `bail` (early-return — daemon down,
 * supervisor missing, agent failure, non-TTY gate) or a `continue` carrying
 * the filled entries + skipped entries + resolved supervisor + computed diff
 * to hand off to the verify phase.
 *
 * @module
 */
import { ok, err, type Result } from "@comis/shared";
import { loadEnvFile, systemGetEnv } from "@comis/core";
import { callAgent } from "../agent-call.js";
import {
  detectSupervisor,
  MANUAL_RECIPE_HINT,
  type Supervisor,
} from "../supervisor.js";
import { buildFillPrompt } from "../prompt-template.js";
import { parseFillResponse } from "../response-parser.js";
import { validatePackageNames } from "../validators.js";
import { isDaemonRunning } from "../../sync-tooling/index.js";
import type {
  FilledEntry,
  HintEntry,
  OrchestratorOpts,
  OrchestratorResult,
  SkippedEntry,
} from "./orchestrator-types.js";
import {
  TOOLFILL_2_GATEWAY_UNREACHABLE,
  TOOLFILL_4_RESTART_REQUIRED,
  TOOLFILL_4_YES_REQUIRED,
} from "./orchestrator-types.js";

/**
 * Outcome of the fill phase. Either a bail with an OrchestratorResult or a
 * continue carrying the per-hint fill state for the verify phase.
 */
export type FillOutcome =
  | { readonly kind: "bail"; readonly result: OrchestratorResult }
  | {
      readonly kind: "continue";
      readonly supervisor: Supervisor;
      readonly filled: readonly FilledEntry[];
      readonly skipped: readonly SkippedEntry[];
      readonly diffString: string;
    };

/**
 * Top-level fill entry. Runs pre-flight gates, then for each discovered
 * hint: prompt → agent call → parse → package-name validation. Accumulates
 * filled + skipped entries; bails out on fatal failure.
 */
export async function fillTools(
  opts: OrchestratorOpts,
  configJs: Record<string, unknown>,
  entries: readonly HintEntry[],
): Promise<FillOutcome> {
  // ---- Pre-flight: daemon must be UP for the LLM call -----------------
  const daemonUp = await isDaemonRunning();
  if (!daemonUp) {
    return {
      kind: "bail",
      result: { exitCode: 1, summary: TOOLFILL_2_GATEWAY_UNREACHABLE },
    };
  }

  // ---- Resolve gateway port + token ------------------------------------
  // loadEnvFile mutates the environment; the caller's env will pick
  // up COMIS_GATEWAY_TOKEN if it's referenced in the config as ${VAR}.
  loadEnvFile(`${opts.homeDir}/.comis/.env`);
  const portToken = resolveGatewayConn(configJs);
  if (!portToken.ok) {
    return { kind: "bail", result: { exitCode: 1, summary: portToken.error } };
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
    return { kind: "bail", result: { exitCode: 1, summary: MANUAL_RECIPE_HINT } };
  }

  // ---- Non-TTY gates (fail-fast BEFORE the LLM call) ------------------
  // The agent call is the expensive step; if we know we cannot confirm
  // (non-TTY without --yes) or cannot restart (non-TTY without --restart
  // or --no-restart), exit immediately so we don't burn an LLM round-trip.
  // Dry-run skips both gates (no confirmation required for a no-op run).
  if (!opts.dryRun) {
    if (!opts.yes && !opts.isTty) {
      return { kind: "bail", result: { exitCode: 1, summary: TOOLFILL_4_YES_REQUIRED } };
    }
    if (opts.restart === undefined && !opts.isTty) {
      return { kind: "bail", result: { exitCode: 1, summary: TOOLFILL_4_RESTART_REQUIRED } };
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
  // Test fault injectors are an exception to the no-runtime-env rule.
  const testAgentResponseRaw = systemGetEnv("COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE");
  const isTestRuntime = systemGetEnv("NODE_ENV") === "test" || systemGetEnv("VITEST") === "true";
  if (testAgentResponseRaw !== undefined && !isTestRuntime) {
    return {
      kind: "bail",
      result: {
        exitCode: 1,
        summary:
          "COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE is a test-only fault injector and must not be set in production. Unset it and retry.",
      },
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
      return {
        kind: "bail",
        result: { exitCode: 1, summary: `Agent call failed for ${entry.name}: ${msg}` },
      };
    }

    const parsed = parseFillResponse(callRes.value.response);
    if (!parsed.ok) {
      const msg = `parse failure: ${parsed.error.reason}`;
      if (opts.all) {
        skipped.push({ name: entry.name, reason: msg });
        continue;
      }
      return {
        kind: "bail",
        result: {
          exitCode: 1,
          summary: `Agent response invalid for ${entry.name}: ${msg}`,
        },
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
    return { kind: "bail", result: { exitCode: 1, summary: agentFailureMessage } };
  }

  if (filled.length === 0) {
    // All entries skipped (only possible with --all + agent failures).
    const skippedReport = skipped
      .map((s) => `${s.name} (${s.reason})`)
      .join(", ");
    return {
      kind: "bail",
      result: { exitCode: 1, summary: `All hints skipped: ${skippedReport}` },
    };
  }

  // ---- Build the diff string for dry-run / confirmation ----------------
  const diffString = renderFillDiff(filled, entries);

  return { kind: "continue", supervisor, filled, skipped, diffString };
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
 * The runtime env read is a documented exception: CLI bootstrap before
 * SecretManager is loaded.
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
  filled: readonly FilledEntry[],
  entries: readonly HintEntry[],
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
