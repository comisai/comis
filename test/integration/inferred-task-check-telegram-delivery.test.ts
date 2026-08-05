// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: an inferred follow-up check-in reaches the user's own chat, and
 * a check that produced no message stays diagnosable in one call.
 *
 * The unit tiers pin the halves: the daemon wiring test pins the check prompt's
 * authority and the metadata the turn carries, and the reader/CLI tests pin the
 * suppression reason on the report. Neither runs the joined path, which is
 * where a real check-in was lost: the model answered the check with the
 * heartbeat token, the attempt was dismissed, and the operator surface said
 * only `outcome=dismissed` — so nothing told an operator whether the runtime
 * had asked the model to decline or the model had found nothing to say.
 *
 * One continuous path with production units only:
 *   real Telegram adapter (`@comis/channels`) over a loopback Bot API mock
 *     → real followup task store (durable JSONL + real file lock)
 *     → real task heartbeat turn executor
 *     → real exact-origin task delivery + real DeliveryService + output guard
 *     → real Telegram Bot API `sendMessage` on the wire
 *     → real TypedEventBus → real scheduler diagnostic rows → real `memory.db`
 *     → real `obs.explain` assembly off that store
 *
 * Only the provider call is stubbed — that is the model boundary. The surrogate
 * obeys the shipped prompt literally, so whether a check-in is delivered is
 * decided by the authority the runtime actually sends: under the prompt that
 * only offered "decline with HEARTBEAT_OK" it declines and the chat stays
 * silent.
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HeartbeatConfigSchema,
  TypedEventBus,
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  createDeliveryService,
  createFileLock,
  createHookRunner,
  createNoOpDeliveryQueue,
  createOutputGuard,
  createPluginRegistry,
  hashWorkspacePolicyContent,
  type ChannelPort,
} from "@comis/core";
import { resolveOperationModel, resolveProviderFamily } from "@comis/agent";
import { assembleIncidentReportFromSources, makeRealReader } from "@comis/daemon";
import { createTelegramPlugin } from "@comis/channels";
import { createObservabilityStore, initSchema } from "@comis/memory";
import { createFollowupTaskStore } from "@comis/scheduler";
import { ok } from "@comis/shared";
import { createTaskHeartbeatAgentTurnExecutor } from "../../packages/daemon/dist/wiring/task-heartbeat-agent-turn-executor.js";
import { createTaskSettledDelivery } from "../../packages/daemon/dist/wiring/task-settled-delivery.js";
import { wireSchedulerDiagnostics } from "../../packages/daemon/dist/observability/obs-scheduler-rows.js";
import {
  createMockTelegramServer,
  type MockTelegramServer,
} from "../e2e/mocks/telegram/mock-telegram-server.js";
import { createMockLogger } from "../support/mock-logger.js";

/** Owner identity and chat used by the local Telegram rig. */
const OWNER_ID = "678314278";
const USER_TEXT = "check in with me in a couple of minutes about the plumber quote";
const IN_TURN_REPLY = "Will do — I'll check back with you about the plumber quote.";
/** The user-facing check-in the model produces for the inferred task. */
const CHECK_IN = "Quick check-in: did the plumber send the quote yet?";
/** `telegram-<botId>`; the mock's getMe answers with bot id 12345. */
const BOT_INSTANCE = "telegram-12345";
/** Admission requires expiry == capturedAtMs + the task lifetime ceiling. */
const TASK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const AGENT_ID = "default";
const TENANT_ID = "default";

function policySnapshot() {
  const content = "# Scope\n\nUse the configured operator scope.";
  const section = {
    id: "workspace:scope",
    sourceKind: "operator" as const,
    trust: "trusted" as const,
    stability: "stable" as const,
    content,
    contentHash: hashWorkspacePolicyContent(content),
    maxChars: 20_000,
  };
  return {
    agentId: AGENT_ID,
    sections: [section],
    combinedHash: computeWorkspacePolicyCombinedHash([section]),
  };
}

/** One extracted candidate bound to the owner's real Telegram endpoint. */
function candidate(itemId: string, text: string, nowMs: number, channelInstanceId = BOT_INSTANCE) {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId,
    conversationId: OWNER_ID,
    conversationKind: "direct" as const,
  };
  const conversation = {
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    partition: { kind: "endpoint-conversation" as const, endpoint },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  const capturedAtMs = nowMs - 300_000;
  return {
    item: {
      itemId,
      sourceExecutionId: `execution-${itemId}`,
      origin: {
        turnScope: { conversation, principal: { principalId: OWNER_ID }, endpoint },
        conversationRef: conversationRef.value,
        deliveryOrigin: {
          tenantId: TENANT_ID,
          channelType: "telegram",
          channelId: OWNER_ID,
          userId: OWNER_ID,
        },
        traceId: randomUUID(),
        trustLevel: "user" as const,
        responseLocalePolicy: { source: "unset" as const, enforceLocale: false },
        backgroundHopCount: 0,
      },
      workspacePolicySnapshot: policySnapshot(),
      responseLocalePolicy: { source: "unset" as const, enforceLocale: false },
      capturedAtMs,
      minimumDueAtMs: nowMs - 240_000,
      userText: USER_TEXT,
      deliveredAssistantText: IN_TURN_REPLY,
    },
    text,
    confidence: 0.92,
    dueEarliestMs: nowMs - 30_000,
    dueLatestMs: nowMs + 600_000,
    expiresAtMs: capturedAtMs + TASK_LIFETIME_MS,
  };
}

interface CapturedTurn {
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly toolCount: number;
  readonly capabilityAccess: unknown;
}

describe("INTEGRATION: inferred follow-up check-ins reach the origin chat and stay diagnosable", () => {
  let mock: MockTelegramServer;
  let adapter: ChannelPort | undefined;
  let inbound: Array<{ text: string; channelId: string; senderId: string }>;
  let dataDir: string;
  let database: Database.Database | undefined;

  /** Every production unit the check path traverses, wired as the daemon wires it. */
  async function rig(options: { readonly declines: boolean }) {
    const clock = { now: () => Date.now(), nowDate: () => new Date() };
    const logger = createMockLogger();
    const store = createFollowupTaskStore({
      filePath: join(dataDir, "tasks.json"),
      lockPath: join(dataDir, "tasks.lock"),
      fileLock: createFileLock(),
      clock,
      idFactory: () => randomUUID(),
      getRuntimeConfig: () => ({ enabled: true, preAcceptanceRetryLimit: 3, quietUntilMs: null }),
    });
    const initialized = await store.initialize();
    expect(initialized.ok).toBe(true);

    const eventBus = new TypedEventBus();
    database = new Database(join(dataDir, "memory.db"));
    initSchema(database, 1_536);
    const obsStore = createObservabilityStore(database);
    wireSchedulerDiagnostics({
      eventBus,
      diagnosticBuffer: { push: (row) => obsStore.insertDiagnostic(row) },
    });
    const terminals: Array<Record<string, unknown>> = [];
    eventBus.on(
      "scheduler:task_check_terminal",
      ((event: Record<string, unknown>) => terminals.push(event)) as never,
    );

    const turns: CapturedTurn[] = [];
    const execute = vi.fn(async (
      message: { text: string; metadata: Record<string, unknown> },
      sessionKey: unknown,
      tools: readonly unknown[],
      _onDelta: unknown,
      _agentId: unknown,
      _directives: unknown,
      _previous: unknown,
      overrides: { capabilityAccess?: unknown },
    ) => {
      turns.push({
        text: message.text,
        metadata: message.metadata,
        toolCount: tools.length,
        capabilityAccess: overrides.capabilityAccess,
      });
      // Literal compliance with the shipped authority: the runtime must ask for
      // the check-in, not merely offer the decline token.
      const offersOnlyDecline = message.text.includes("Decline by replying with HEARTBEAT_OK.");
      return {
        response: options.declines || offersOnlyDecline ? "HEARTBEAT_OK" : CHECK_IN,
        sessionKey,
        responseLocalePolicy: { source: "unset", enforceLocale: false },
        workspacePolicyHash: policySnapshot().combinedHash,
        tokensUsed: { input: 420, output: 18, total: 438 },
        cost: { total: 0.0031 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      };
    });

    const agentConfig = {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      operationModels: {},
      promptTimeout: { promptTimeoutMs: 180_000 },
      scheduler: { heartbeat: { enabled: true, intervalMs: 300_000, showAlerts: true } },
    };
    const delivery = createTaskSettledDelivery({
      clock,
      adaptersByType: new Map([["telegram", adapter as never]]),
      deliveryService: createDeliveryService({
        hookRunner: createHookRunner(createPluginRegistry(), { eventBus, catchErrors: true }),
        deliveryQueue: createNoOpDeliveryQueue(),
        logger,
        clock,
        eventBus,
      }),
      outputGuard: createOutputGuard(),
      deliveredHistory: { append: async () => ok("appended" as const) },
      eventBus,
      logger,
    });
    const executeCheck = createTaskHeartbeatAgentTurnExecutor({
      tenantId: TENANT_ID,
      bootId: "boot-integration",
      agents: { [AGENT_ID]: agentConfig as never },
      globalHeartbeatConfig: HeartbeatConfigSchema.parse({}),
      taskConfig: { maxPerCheck: 3, maxPerDayPerConversation: 3 },
      clock,
      eventBus,
      getStore: () => store,
      getExecutor: () => ({ execute } as never),
      getWorkspaceDir: () => dataDir,
      resolveModel: (_agentId: string, config: typeof agentConfig) => resolveOperationModel({
        operationType: "heartbeat",
        agentProvider: config.provider,
        agentModel: config.model,
        operationModels: config.operationModels,
        providerFamily: resolveProviderFamily(config.provider),
        agentPromptTimeoutMs: config.promptTimeout.promptTimeoutMs,
      }),
      delivery,
      idFactory: () => randomUUID(),
      logger,
    } as never);

    async function runCheck(rootRunId: string) {
      return executeCheck({
        correlationId: randomUUID(),
        target: { kind: "agent", agentId: AGENT_ID },
        lane: "task",
        reason: "task",
        rootRunId,
        eventBatch: [],
        signal: new AbortController().signal,
      });
    }

    return { store, obsStore, runCheck, terminals, turns };
  }

  function sentTexts(): string[] {
    return mock.getCapturedEvents()
      .filter((event) => event.type === "send-message")
      .map((event) => String(event.payload.text));
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "comis-inferred-check-"));
    mock = createMockTelegramServer();
    const handle = await mock.start();
    const plugin = createTelegramPlugin({
      getBotToken: () => "12345:test",
      apiRoot: handle.baseUrl,
      logger: createMockLogger(),
    });
    adapter = plugin.adapter;
    inbound = [];
    adapter.onMessage(async (message) => {
      inbound.push({
        text: message.text,
        channelId: message.channelId,
        senderId: message.senderId,
      });
    });
    const started = await adapter.start();
    if (!started.ok) throw started.error;
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The owner's ask arrives over the real Bot API wire, and the in-turn reply
    // is committed on the same wire — the turn the follow-up is inferred from.
    mock.injectInboundMessage({ from: OWNER_ID, channel: OWNER_ID, content: USER_TEXT });
    const deadline = Date.now() + 5_000;
    while (inbound.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(inbound).toHaveLength(1);
    expect((await adapter.sendMessage(inbound[0]!.channelId, IN_TURN_REPLY)).ok).toBe(true);
  });

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
    await mock.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("delivers the inferred check-in to the owner's own chat under a zero-capability turn", async () => {
    const { store, runCheck, terminals, turns } = await rig({ declines: false });
    const admitted = await store.admitCandidates({
      candidates: [candidate("item-plumber-quote", "Check whether the plumber quote arrived", Date.now())],
      confidenceThreshold: 0.8,
    });
    expect(admitted.ok).toBe(true);

    const rootRunId = `root-task-check-${randomUUID()}`;
    const outcome = await runCheck(rootRunId);

    // The check turn keeps the inferred-task authority and the zero-capability
    // posture: no tools, no capability access, no scheduled-reminder framing.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain(
      "Reply with HEARTBEAT_OK only when no safe, useful check-in can be formed from any task.",
    );
    expect(turns[0]!.text).toContain("Otherwise return the concise user-facing check-in now.");
    expect(turns[0]!.metadata).toEqual({
      trigger: "task_check",
      correlationId: expect.any(String),
    });
    expect(turns[0]!.toolCount).toBe(0);
    expect(turns[0]!.capabilityAccess).toBe("none");
    // The task text still travels as untrusted data.
    expect(turns[0]!.text).toContain("UNTRUSTED");

    // The user sees the unprompted check-in in the same chat, nowhere else.
    expect(sentTexts()).toEqual([IN_TURN_REPLY, CHECK_IN]);
    const sends = mock.getCapturedEvents().filter((event) => event.type === "send-message");
    expect(String(sends.at(-1)!.payload.chatId)).toBe(OWNER_ID);

    expect(outcome).toMatchObject({
      ok: true,
      value: { status: "settled", delivery: { status: "accepted", deliveredChunks: 1 } },
    });
    // Durable authority: the attempt settled as delivered, with the wire's id.
    const persisted = JSON.parse(readFileSync(join(dataDir, "tasks.json"), "utf8")) as {
      attempts: Array<Record<string, unknown>>;
    };
    expect(persisted.attempts.at(-1)).toMatchObject({
      status: "delivered",
      deliveredChunks: 1,
      failedChunks: 0,
      lastPlatformMessageId: expect.any(String),
    });
    // A delivered check carries no suppression reason to explain away.
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ outcome: "delivered", deliveredChunks: 1 });
    expect(terminals[0]!.suppressionReason).toBeUndefined();
  });

  it("names why a silent check produced no message, in one explain call", async () => {
    const { store, obsStore, runCheck, terminals } = await rig({ declines: true });
    const admitted = await store.admitCandidates({
      candidates: [candidate("item-dentist-slot", "Check whether the dentist slot was confirmed", Date.now())],
      confidenceThreshold: 0.8,
    });
    expect(admitted.ok).toBe(true);

    const rootRunId = `root-task-check-${randomUUID()}`;
    const outcome = await runCheck(rootRunId);

    // Nothing further reached the chat — only the original in-turn reply.
    expect(sentTexts()).toEqual([IN_TURN_REPLY]);
    expect(outcome).toMatchObject({
      ok: true,
      value: { delivery: { status: "suppressed", reason: "heartbeat_token" } },
    });
    expect(terminals[0]).toMatchObject({
      outcome: "dismissed",
      suppressionReason: "heartbeat_token",
    });

    // One call over the durable store answers WHY the chat stayed silent.
    const report = await assembleIncidentReportFromSources(
      makeRealReader(dataDir, obsStore),
      dataDir,
      { rootRunId, depth: "summary" },
    );
    expect(report.taskCheck).toMatchObject({
      rootRunId,
      outcome: "dismissed",
      suppressionReason: "heartbeat_token",
    });
    // Content-free: the report carries the verdict, never the task text.
    expect(JSON.stringify(report)).not.toContain("dentist");
  });

  it("refuses to deliver a check whose origin names a different bot instance", async () => {
    const { store, obsStore, runCheck, terminals } = await rig({ declines: false });
    const admitted = await store.admitCandidates({
      candidates: [
        candidate("item-foreign", "Check the foreign-endpoint task", Date.now(), "telegram-99999"),
      ],
      confidenceThreshold: 0.8,
    });
    expect(admitted.ok).toBe(true);

    const rootRunId = `root-task-check-${randomUUID()}`;
    const outcome = await runCheck(rootRunId);

    // The bound adapter is `telegram-12345`; nothing is sent for a task whose
    // origin names another instance, and the failure is honest.
    expect(sentTexts()).toEqual([IN_TURN_REPLY]);
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        delivery: { status: "pre_send_failed", reason: "target_precondition", errorKind: "precondition" },
      },
    });
    expect(terminals[0]).toMatchObject({ outcome: "retry_scheduled", errorKind: "precondition" });

    const report = await assembleIncidentReportFromSources(
      makeRealReader(dataDir, obsStore),
      dataDir,
      { rootRunId, depth: "summary" },
    );
    expect(report.taskCheck).toMatchObject({ outcome: "retry_scheduled" });
    expect(report.taskCheck?.suppressionReason).toBeUndefined();
  });
});
