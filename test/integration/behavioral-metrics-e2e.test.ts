// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-gated behavioral metrics suite.
 *
 * GATE: skipped entirely unless COMIS_E2E_TEST_PROVIDERS is set
 * (e.g., COMIS_E2E_TEST_PROVIDERS="anthropic,openai-codex,google").
 *
 * Contract: rates REPORT only -- never gate CI. The deterministic CI gate is
 * the dedicated refusal-mode integration test, which lives in a separate file
 * and runs always.
 *
 * Cost note: ROUNDS_PER_PROVIDER x providers x ~3 tool calls per round
 * = ~3 x ROUNDS x providers API calls. Defaults to 10 rounds.
 * Override via COMIS_E2E_TEST_ROUNDS=<int>.
 *
 * @module
 */

// -----------------------------------------------------------------------------
// CI POLICY:
//
// This suite is GATED by COMIS_E2E_TEST_PROVIDERS. CI does NOT set this var,
// so the suite is "skipped" on every PR. Rates report ONLY -- they are
// documented as non-binding (a flat behavioral metric is not a regression).
//
// The deterministic CI-gating behavioral surface is the refusal-mode
// integration test -- separate file, runs always.
// -----------------------------------------------------------------------------

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import {
  DAEMON_STARTUP_MS,
  RPC_LLM_MS,
  RPC_FAST_MS,
} from "../support/timeouts.js";
import type { TypedEventBus, EventMap } from "@comis/core";
import {
  MetricAggregator,
  computeRoundSignals,
  type ToolEvent,
  type InstallDetourEvent,
} from "../support/metric-aggregator.js";
import {
  parseTestProviders,
  parseRoundsPerProvider,
} from "../support/test-providers.js";

// ---------------------------------------------------------------------------
// Path / env resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Advise-mode test config -- gateway port 8506 (the original 8505 collided
// with config.test-sessions-lifecycle).
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-tooling-fixtures.yaml",
);

// Output target -- mirrors test/.test-results.json from orchestrate.ts.
// global-setup.ts does NOT auto-clean this file -- developers keep the latest
// report locally. The file is gitignored via .gitignore.
const METRICS_FILE = resolve(__dirname, "..", ".test-behavioral-metrics.json");

const PROVIDERS = parseTestProviders();
const ROUNDS_PER_PROVIDER = parseRoundsPerProvider();

// ---------------------------------------------------------------------------
// Helper: distinguish JSON-RPC error envelopes from successful responses.
// sendJsonRpc resolves with the full response object -- it does NOT throw on
// RPC error. We inspect .error here so the caller can branch on the message.
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function rpcErrorMessage(response: unknown): string | undefined {
  const r = response as JsonRpcResponse | undefined;
  if (!r || typeof r !== "object") return undefined;
  if (!r.error) return undefined;
  return typeof r.error.message === "string" ? r.error.message : undefined;
}

// ---------------------------------------------------------------------------
// Suite -- skip gate driven by the parsed provider list
// ---------------------------------------------------------------------------

describe.skipIf(PROVIDERS.length === 0)(
  "Behavioral metrics -- provider-gated",
  () => {
    let handle: TestDaemonHandle;
    let eventBus: TypedEventBus;
    const aggregator = new MetricAggregator();

    beforeAll(async () => {
      handle = await startTestDaemon({ configPath: CONFIG_PATH });
      eventBus = (
        handle.daemon.container as unknown as { eventBus: TypedEventBus }
      ).eventBus;
    }, DAEMON_STARTUP_MS + 30_000);

    afterAll(async () => {
      // Write the metrics report BEFORE cleaning up the daemon -- the report
      // is the only durable artifact this suite produces. Failure to write is
      // NOT fatal (the suite reports only -- it never gates), so we swallow
      // write errors to avoid masking a real daemon-cleanup failure that
      // afterAll surfaces afterwards.
      try {
        const report = aggregator.finalize([
          "tool-first-replay",
          "phase-8-skill-variants/operator-config-skill",
          "phase-8-skill-variants/comis-capability-skill",
          "phase-8-skill-variants/sdk-fallback-skill",
        ]);
        writeFileSync(METRICS_FILE, JSON.stringify(report, null, 2));
      } catch {
        // Report-write failure is non-fatal -- see comment above.
      }

      if (handle) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) throw err;
        }
      }
    }, 120_000);

    // -----------------------------------------------------------------------
    // Per-provider replay loop -- it.each parameterizes over the parsed list
    // -----------------------------------------------------------------------

    it.each(PROVIDERS)(
      "captures four metric rates for provider %s across ROUNDS_PER_PROVIDER rounds",
      async (provider) => {
        // Idempotently create a per-provider agent. The default agent's provider
        // (anthropic, per config.test-tooling-fixtures.yaml) may not match the
        // requested provider; spawning a dedicated agent keeps the aggregator
        // keyed correctly.
        const providerAgentId = `${provider}-test-agent`;

        // -------------------------------------------------------------------
        // PINNED ADMIN TRUST-LEVEL PATH:
        // packages/daemon/src/api/agent-handlers.ts:96-98 enforces
        // _trustLevel === "admin". The internal rpcCall closure does NOT
        // pass _trustLevel by default. Routing via the WebSocket gateway
        // is the idiomatic surface -- setup-gateway-api.ts:51-53 auto-
        // injects `_trustLevel: "admin"` for every method registered under
        // the "admin" scope (agents.create is in that batch at line 190).
        //
        // The test config declares scopes: ["rpc", "ws", "admin"] for the
        // gateway token, so this path is verified at config-time.
        //
        // CRITICAL: distinguish the two error modes --
        //   "Agent already exists"     -> acceptable; idempotent (prior run
        //                                 created this agent, the test config
        //                                 reuses the same DB).
        //   "Admin access required"    -> test misconfigured; fail loudly.
        // sendJsonRpc resolves with the full envelope (.result | .error),
        // so we inspect response.error.message rather than try/catch.
        // -------------------------------------------------------------------
        const agentSetupWs = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );
        try {
          const createResp = await sendJsonRpc(
            agentSetupWs,
            "agents.create",
            {
              agentId: providerAgentId,
              config: {
                provider,
                // Model selection is provider-specific -- leave to provider
                // default. COMIS_E2E_TEST_MODELS is documented as a future
                // enhancement; the daemon picks the configured default for now.
              },
            },
            Date.now(),
            { timeoutMs: RPC_FAST_MS },
          );
          const createErr = rpcErrorMessage(createResp);
          if (createErr) {
            if (/already exists/i.test(createErr)) {
              // Idempotent -- acceptable. Prior test run already created this
              // agent in the test memory DB; the config persists across the
              // beforeAll/afterAll boundary unless cleanup wiped the DB.
            } else if (/admin access required/i.test(createErr)) {
              // Test misconfigured -- token does NOT have admin scope.
              // The config declares scopes: ["rpc", "ws", "admin"] -- if this
              // fires, someone changed the test config. Fail loudly rather
              // than silently fall back to the default agent.
              throw new Error(
                `Test daemon's gateway token lacks admin scope. ` +
                  `Verify test/config/config.test-tooling-fixtures.yaml ` +
                  `gateway.tokens[0].scopes includes "admin". ` +
                  `Original error: ${createErr}`,
              );
            } else {
              // Re-throw any unexpected error -- silent swallow masks bugs.
              throw new Error(
                `agents.create failed for provider ${provider}: ${createErr}`,
              );
            }
          }
        } finally {
          agentSetupWs.close();
        }

        // -------------------------------------------------------------------
        // Replay rounds -- one WS connection drives all rounds for this
        // provider; per-round event listeners capture the tool sequence.
        // -------------------------------------------------------------------
        const ws = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );
        try {
          for (let round = 0; round < ROUNDS_PER_PROVIDER; round++) {
            const toolEvents: ToolEvent[] = [];
            const detourEvents: InstallDetourEvent[] = [];
            const hintAugmentations: boolean[] = [];

            const toolListener = (
              e: EventMap["tool:executed"],
            ): void => {
              toolEvents.push({
                toolName: e.toolName,
                timestamp: e.timestamp,
                success: e.success,
                params: e.params,
              });
            };
            const detourListener = (
              e: EventMap["tool:install_detour_detected"],
            ): void => {
              detourEvents.push({
                action: e.action,
                mode: e.mode,
                timestamp: e.timestamp,
              });
              if (e.action === "hinted") {
                // Best-effort augmentation tracking -- see metric-aggregator.ts
                // module JSDoc. Without per-overlap result-envelope inspection
                // we record one truth-value per "hinted" event, which makes
                // the installDetourHintCoverage rate structurally constant
                // at 1.0 by construction. The metric DEFINITION is verified
                // deterministically in synthetic-event-stream unit tests; the
                // per-overlap tracking enhancement is deferred.
                hintAugmentations.push(true);
              }
            };

            eventBus.on("tool:executed", toolListener);
            eventBus.on("tool:install_detour_detected", detourListener);

            try {
              const execResp = await sendJsonRpc(
                ws,
                "agent.execute",
                {
                  agentId: providerAgentId,
                  message:
                    "Show me a 1-month chart of AAPL using your available tools.",
                },
                round + 1,
                { timeoutMs: RPC_LLM_MS },
              );
              // Errors here (provider 4xx/5xx/timeout/rate-limit) are
              // acceptable -- the round's events were captured up to the
              // failure point. The aggregator handles partial rounds via
              // computeRoundSignals (graceful on empty event arrays).
              const execErr = rpcErrorMessage(execResp);
              if (execErr) {
                // Intentionally swallow -- rates report only.
                void execErr;
              }
            } catch {
              // sendJsonRpc itself only rejects on transport-level failure
              // (timeout, socket close). Treat the same as a partial round.
            }

            // Allow async event flush (Pino + executor)
            await new Promise((r) => setTimeout(r, 1500));

            eventBus.off("tool:executed", toolListener);
            eventBus.off("tool:install_detour_detected", detourListener);

            const signals = computeRoundSignals(
              toolEvents,
              detourEvents,
              hintAugmentations,
            );
            aggregator.recordRound(provider, signals);
          }
        } finally {
          ws.close();
        }

        // Structural assertion -- the round count matches what we drove.
        // No expect on rate VALUES -- rates REPORT only.
        expect(aggregator.roundCount(provider)).toBe(ROUNDS_PER_PROVIDER);
      },
      // Per-provider timeout: ROUNDS x ~30s per LLM round + buffer.
      ROUNDS_PER_PROVIDER * 60_000 + 60_000,
    );

    // -----------------------------------------------------------------------
    // Report shape verification (after all providers complete)
    //
    // SHAPE assertions only -- rate VALUES are non-binding. Proves field
    // existence and numeric typing; never compares rate to a threshold
    // like 0.5.
    // -----------------------------------------------------------------------

    it("emits a MetricsReport with the expected shape (rates report only -- never gate)", () => {
      const report = aggregator.finalize([]);
      expect(report.totalRounds).toBe(PROVIDERS.length * ROUNDS_PER_PROVIDER);
      for (const provider of PROVIDERS) {
        const p = report.providers[provider];
        expect(p).toBeDefined();
        expect(p!.rounds).toBe(ROUNDS_PER_PROVIDER);
        // Shape assertions ONLY -- rate VALUES are non-binding.
        expect(typeof p!.firstNonDiscoveryActionIsMcp.rate).toBe("number");
        expect(p!.firstNonDiscoveryActionIsMcp.rate).toBeGreaterThanOrEqual(0);
        expect(p!.firstNonDiscoveryActionIsMcp.rate).toBeLessThanOrEqual(1);
        expect(typeof p!.firstNonDiscoveryActionIsInstall.rate).toBe("number");
        expect(typeof p!.installBeforeFirstMcpDataFetch.rate).toBe("number");
        expect(typeof p!.installDetourHintCoverage.rate).toBe("number");
      }
      expect(typeof report.timestamp).toBe("string");
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  },
);
