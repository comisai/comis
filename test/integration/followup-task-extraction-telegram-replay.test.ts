// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: a dropped follow-up task extraction stays diagnosable from the
 * durable operator surfaces — joined across every layer that carries the
 * verdict.
 *
 * The two unit tiers each pin one half of this chain: the daemon wiring seam
 * (`setup-followup-task-extraction.test.ts`) proves the runner's closed parser
 * code reaches the event, and the trajectory bridge test proves the bridge
 * copies it onto the record. Neither proves the joined path, which is where the
 * code was actually lost: a real Telegram check-in produced a rejected
 * extraction whose durable trajectory record named only
 * `stage=model_output` / `errorKind=validation`, so an operator could not tell
 * WHICH parser rule dropped the batch.
 *
 * This test runs one continuous path with production units only:
 *   Telegram Bot API wire (127.0.0.1 mock + the real `@comis/channels` adapter)
 *     → real inbound NormalizedMessage + real outbound reply
 *     → real follow-up extraction composition (`createFollowupTaskExtractionRuntime`)
 *     → real task-extraction runner + closed output parser
 *     → real TypedEventBus
 *     → real trajectory bridge + real file recorder (durable JSONL on disk)
 *     → real scheduler diagnostic-row projection (the `obs_diagnostics` shape)
 *
 * Only the extraction model call is stubbed — that is the provider boundary,
 * and it returns a due window inside the floor so the REAL parser closes with
 * `before_minimum_due`.
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
  type NormalizedMessage,
  type TaskExtractionTurn,
} from "@comis/core";
import type { ChannelPort } from "@comis/core";
import type { AgentExecutor, ExecutionResult } from "@comis/agent";
import { createTelegramPlugin } from "@comis/channels";
import { attachTrajectoryToEventBus, createTrajectoryRecorder } from "@comis/observability";
import { ok } from "@comis/shared";
import { createFollowupTaskExtractionRuntime } from "../../packages/daemon/dist/wiring/setup-followup-task-extraction.js";
import { wireSchedulerDiagnostics } from "../../packages/daemon/dist/observability/obs-scheduler-rows.js";
import {
  createMockTelegramServer,
  type MockTelegramServer,
} from "../e2e/mocks/telegram/mock-telegram-server.js";
import { createMockLogger } from "../support/mock-logger.js";
import { createFakeTimers } from "../support/fake-timers.js";

/** Owner identity and chat used by the local Telegram rig. */
const OWNER_ID = "678314278";
const CHECK_IN_TEXT = "check in with me in a couple of minutes about the plumber quote";
const DELIVERED_REPLY = "Will do — I'll check back with you about the plumber quote.";
/** Candidate text the model produced; must never reach the durable record. */
const CANDIDATE_TEXT = "Check the plumber quote outcome";
/** Turn capture instant and the runner clock, chosen so 30s is inside the floor. */
const CAPTURED_AT_MS = 1_000;
const NOW_MS = 2_000;

interface DiagnosticRow {
  readonly category: string;
  readonly severity: string;
  readonly agentId: string;
  readonly message: string;
  readonly details: string;
}

function extractionTurn(inbound: NormalizedMessage, reply: string): TaskExtractionTurn {
  const conversation = {
    tenantId: "default",
    agentId: "default",
    partition: { kind: "agent" as const },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  const content = "# Scope\n\nUse the configured scope.";
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
    sourceExecutionId: "execution-b10-checkin",
    origin: {
      turnScope: {
        conversation,
        principal: { principalId: inbound.senderId },
        endpoint: {
          channelType: "telegram",
          channelInstanceId: "telegram-12345",
          conversationId: inbound.channelId,
          conversationKind: "direct",
        },
      },
      conversationRef: conversationRef.value,
      deliveryOrigin: {
        tenantId: "default",
        channelType: "telegram",
        channelId: inbound.channelId,
        userId: inbound.senderId,
      },
      traceId: "trace-b10-checkin",
      trustLevel: "user",
      responseLocalePolicy: { source: "unset", enforceLocale: false },
      backgroundHopCount: 0,
    },
    workspacePolicySnapshot: {
      agentId: "default",
      sections: [section],
      combinedHash: computeWorkspacePolicyCombinedHash([section]),
    },
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    capturedAtMs: CAPTURED_AT_MS,
    userText: inbound.text,
    deliveredAssistantText: reply,
  };
}

function execution(response: string): ExecutionResult {
  return {
    response,
    sessionKey: { tenantId: "default", userId: "scheduler", channelId: "task" },
    tokensUsed: { input: 10, output: 5, total: 15 },
    cost: { total: 0.001 },
    stepsExecuted: 0,
    llmCalls: 1,
    finishReason: "stop",
  };
}

describe("INTEGRATION: dropped follow-up extraction stays diagnosable end to end", () => {
  let mock: MockTelegramServer;
  let adapter: ChannelPort | undefined;
  let inbound: NormalizedMessage[];
  let trajectoryDir: string;

  beforeEach(async () => {
    trajectoryDir = mkdtempSync(join(tmpdir(), "comis-b10-replay-"));
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
      inbound.push(message);
    });
    const started = await adapter.start();
    if (!started.ok) throw started.error;
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
    await mock.stop();
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  it("names the closed parser rule on the durable trajectory record and diagnostic row", async () => {
    // 1. The owner's check-in arrives over the real Bot API wire.
    mock.injectInboundMessage({
      from: OWNER_ID,
      channel: OWNER_ID,
      content: CHECK_IN_TEXT,
    });
    const deadline = Date.now() + 5_000;
    while (inbound.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe(CHECK_IN_TEXT);
    expect(inbound[0].senderId).toBe(OWNER_ID);

    // 2. The reply the user sees is committed on the same wire.
    const sent = await adapter!.sendMessage(inbound[0].channelId, DELIVERED_REPLY);
    expect(sent.ok).toBe(true);

    // 3. Durable operator surfaces: real trajectory recorder + real bridge, and
    //    the scheduler diagnostic-row projection that backs `obs_diagnostics`.
    const sessionId = `default:agent:default:telegram:peer:${OWNER_ID}`;
    const recorderResult = createTrajectoryRecorder({
      agentId: "default",
      tenantId: "default",
      sessionId,
      trajectoryDir,
    });
    expect(recorderResult.ok).toBe(true);
    if (!recorderResult.ok || recorderResult.value === null) return;
    const recorder = recorderResult.value;
    const eventBus = new TypedEventBus();
    attachTrajectoryToEventBus({ eventBus, recorder });
    const rows: DiagnosticRow[] = [];
    wireSchedulerDiagnostics({ eventBus, diagnosticBuffer: { push: (row) => rows.push(row) } });

    // 4. The real follow-up extraction composition, with only the provider call
    //    stubbed: both the first response and the repair response put the due
    //    window inside the floor (captured 1_000 + 60_000), so the closed parser
    //    rejects with `before_minimum_due`.
    const timers = createFakeTimers();
    let sequence = 0;
    let itemId = "missing";
    const execute = vi.fn(async (message: { text: string }) => {
      itemId = /Item (\S+)/u.exec(message.text)?.[1] ?? itemId;
      return execution(JSON.stringify({
        candidates: [{
          itemId,
          text: CANDIDATE_TEXT,
          dueInSecondsEarliest: 30,
          dueInSecondsLatest: 120,
          confidence: 0.9,
        }],
      }));
    });
    const admitCandidates = vi.fn(async () => ok([]));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const config = {
      tenantId: "default",
      agents: {
        default: {
          provider: "openai-codex",
          model: "openai-codex:gpt-5.6-luna",
          operationModels: {
            taskExtraction: { model: "primary", timeout: 60_000 },
          },
          promptTimeout: { promptTimeoutMs: 180_000 },
          scheduler: { heartbeat: { enabled: false, intervalMs: 60_000 } },
        },
      },
      scheduler: {
        tasks: {
          enabled: true,
          confidenceThreshold: 0,
          debounceMs: 1_000,
          batchMax: 8,
          maxPerCheck: 3,
          maxPerDayPerConversation: 3,
          defaultWindowMs: 43_200_000,
          preAcceptanceRetryLimit: 3,
        },
        heartbeat: { enabled: false, intervalMs: 60_000 },
      },
    };
    const runtime = createFollowupTaskExtractionRuntime({
      config: config as never,
      clock: { now: () => NOW_MS, nowDate: () => new Date(NOW_MS) },
      timers,
      eventBus,
      logger: logger as never,
      taskStores: new Map([["default", { admitCandidates } as never]]),
      workspaceDirs: new Map([["default", "/workspace/default"]]),
      getExecutor: () => ({ execute } as unknown as AgentExecutor),
      leaseManager: { mintLease: () => ({ leaseId: "lease-b10", bearer: "bearer-b10" }), revoke: vi.fn() } as never,
      outputGuard: { registerSecret: vi.fn() },
      boundedAutonomyHolder: {
        current: { registerRoot: vi.fn(), evictRootIfIdle: vi.fn() },
      } as never,
      onTaskStoreChanged: vi.fn(async () => ok(undefined)),
      idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;

    expect(runtime.value.taskExtractionPort.enqueue(extractionTurn(inbound[0], DELIVERED_REPLY)))
      .toEqual(ok("enqueued"));
    timers.advance(1_000);
    await runtime.value.waitForIdle();

    // Nothing was admitted: the batch is dropped, exactly as the campaign saw.
    expect(admitCandidates).not.toHaveBeenCalled();

    // 5. The durable trajectory file — what an operator actually reads.
    await recorder.flush();
    await recorder.flushAndClose();
    const records = readFileSync(recorder.filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
    const failure = records.find((record) => record.type === "scheduler.task_extraction_failed");
    expect(failure).toBeDefined();
    expect(failure!.data).toMatchObject({
      stage: "model_output",
      errorKind: "validation",
      outputErrorCode: "before_minimum_due",
      sourceExecutionIds: ["execution-b10-checkin"],
    });
    // The verdict travels; the rejected model output does not.
    expect(JSON.stringify(failure)).not.toContain(CANDIDATE_TEXT);

    // 6. The diagnostic row behind `obs_diagnostics` carries the same verdict.
    const row = rows.find((entry) => entry.message === "scheduler:task_extraction_failed");
    expect(row).toBeDefined();
    expect(row!.category).toBe("health_signal");
    expect(row!.severity).toBe("warning");
    expect(JSON.parse(row!.details)).toMatchObject({
      signal: "task_extraction_failed",
      stage: "model_output",
      errorKind: "validation",
      outputErrorCode: "before_minimum_due",
    });
    expect(row!.details).not.toContain(CANDIDATE_TEXT);
  });
});
