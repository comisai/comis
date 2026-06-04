// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated real-LLM regression driver — the design's "/v1" (version-1 of the
 * real-LLM harness; NOT a route or an existing repo symbol).
 *
 * It stands up the MINIMAL real-provider driver for the Lossless Context DAG
 * (v2.12) work: two probes that drive a context turn through the REAL pipeline
 * context engine (`createContextEngine({ version: "pipeline" }).transformContext`)
 * + the cache-trace wrapper (`buildCacheTraceWrapper(trace)(next)`), recording
 * the `stream:context` cache-trace event so the assembled-array invariant (O2 —
 * the `assembledShape` descriptor added in Plan 126-05) can be asserted against a
 * REAL provider:
 *
 *   1. TOOL-FREE BASELINE — drive one tool-free turn against the real answer
 *      model (a live `completeSimple` call proves the driver actually reaches a
 *      provider when enabled), then assemble + record `stream:context`; assert it
 *      carries `messageRoles` + an `assembledShape` (no tool_result on a tool-free
 *      turn).
 *   2. SINGLE-READ PROBE — drive a forced single-read tool turn (user ->
 *      assistant-with-tool_use -> toolResult -> assistant) through the same
 *      pipeline + wrapper; assert the recorded `stream:context`
 *      `assembledShape.hasToolResult === true`, the tool_use<->tool_result
 *      pairing holds, and the array GREW vs the baseline turn.
 *
 *   The DEEP loop-fix assertion (a single forced read feeds the tool_result back
 *   in <=2 reads) is PHASE 128's gate against the new store — here we only stand
 *   up the probe + record O2.
 *
 * TWO-TIER GATE (mirrors qa-judge-harness.bench.test.ts):
 *   - UNGATED (default CI, `pnpm test` / `pnpm validate`): `COMIS_LCD_REGRESSION`
 *     is unset, so `describe.skipIf` SKIPS this entire suite — no provider call,
 *     no network, no cost reaches CI. (The deterministic O2 invariant is already
 *     pinned by the always-on provider-boundary-harness.test.ts.)
 *   - GATED (this file, run by hand): `COMIS_LCD_REGRESSION=1` enables the suite;
 *     the provider-backed probes additionally nest behind the answer-model env
 *     (`COMIS_LCD_ANSWER_{PROVIDER,MODEL,API_KEY}`). Absent any of those ->
 *     `it.skipIf` skips the probe.
 *
 * SECURITY (Shared Pattern E + T-126-16/T-126-17):
 *   - The operator places the provider key ONLY in a git-ignored
 *     `scripts/lcd-regression.env` (mirroring `scripts/bench-memory.env`); the
 *     committed `scripts/lcd-regression.env.example` documents the vars. The key
 *     is read via `process.env` at THIS `.test.ts` boundary (the `src/**` globals
 *     rule excludes `.test.ts`) and forwarded to pi-ai's typed `apiKey` option —
 *     never stored, never committed.
 *   - Each probe uses a fresh `mkdtempSync` tmp trace dir (NEVER ~/.comis).
 *   - `console.log` emits ONLY structured metrics (counts + durations) — NEVER an
 *     API key or a model answer body. `includeMessages` is OFF on the trace so the
 *     recorded JSONL carries no message bodies either; `assembledShape` is the
 *     counts/flags descriptor.
 *   - `COMIS_LCD_LIMIT` cost-bounds the probe count when the suite is enabled.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
// VALUE completion entry point (fine in a .test.ts) — the real answer LLM call.
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import type { ContextEngineConfig } from "@comis/core";
import {
  buildCacheTraceWrapper,
  createCacheTrace,
  type CacheTrace,
  type CacheTraceEvent,
} from "@comis/observability";

import { createContextEngine } from "./context-engine.js";
import type { ContextEngineDeps } from "./types.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ENV GATES — read process.env ONLY at the test boundary (allowed in a .test.ts;
// the globals rule scopes to src/**). Names pinned by this plan (126-06).
const COMIS_LCD_REGRESSION = process.env.COMIS_LCD_REGRESSION; // master gate
const ANSWER_PROVIDER = process.env.COMIS_LCD_ANSWER_PROVIDER;
const ANSWER_MODEL = process.env.COMIS_LCD_ANSWER_MODEL;
const ANSWER_API_KEY = process.env.COMIS_LCD_ANSWER_API_KEY;
const COMIS_LCD_LIMIT = process.env.COMIS_LCD_LIMIT; // cost-bound: cap probe count

/** Per-LLM-call wall-clock deadline (a standard timer is allowed in a .test.ts). */
const LLM_TIMEOUT_MS = 120_000;
/** Harness version stamp — a number is always attributable to fixed harness code. */
const DRIVER_VERSION = "phase-126-v1";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-lcd-regression-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- JSONL read-back (Shared Pattern A — stream-fn-wrapper.test.ts:38-45). ---
function readLines(filePath: string): CacheTraceEvent[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l)) as CacheTraceEvent[];
}

// --- makeTrace (stream-fn-wrapper.test.ts:47-59). includeMessages is OFF: the
//     assembledShape descriptor must be present regardless, and no message body
//     is ever written to the JSONL. ---
function makeTrace(filePath: string): CacheTrace {
  const trace = createCacheTrace({
    enabled: true,
    filePath,
    includeMessages: false,
    includePrompt: true,
    includeSystem: true,
    agentId: "agent-lcd",
    sessionId: "sid-lcd",
  });
  if (trace === null) throw new Error("makeTrace returned null");
  return trace;
}

// --- fake model + fake StreamFn (stream-fn-wrapper.test.ts:64-104). The fake
//     `next` returns a bare object so the wrapper's "no .result() function"
//     fallback fires — the wrapper records `stream:context` from the assembled
//     array WITHOUT a second real network call (the real provider call already
//     happened in the tool-free baseline probe). ---
function fakeModel(): unknown {
  return { provider: "anthropic", id: "lcd-regression-recorder" };
}

const fakeNext: StreamFn = ((..._args: unknown[]) =>
  ({}) as ReturnType<StreamFn>) as StreamFn;

// --- Minimal pipeline deps (provider-boundary-harness.test.ts:108-118). A
//     reasoning model so the full pipeline runs; the layers are no-ops on these
//     tiny inputs. ---
function makeDeps(): ContextEngineDeps {
  const logger = createMockLogger();
  return {
    logger: logger as unknown as ContextEngineDeps["logger"],
    getModel: () => ({
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 8_192,
    }),
  };
}

const pipelineConfig: ContextEngineConfig = {
  enabled: true,
  thinkingKeepTurns: 10,
  historyTurns: 15,
  version: "pipeline",
};

// --- Message-shape builders (provider-boundary-harness.test.ts:129-150). ---
function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

function assistantTextMsg(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}

function assistantWithToolUse(id: string, name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  } as AgentMessage;
}

function toolResultMsg(toolCallId: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text: "ok" }],
  } as AgentMessage;
}

/**
 * Drive one turn through the REAL pipeline engine + the cache-trace wrapper, then
 * read back the recorded `stream:context` line. The assembled array is the SAME
 * one a real provider call would receive; the wrapper records its shape (O2).
 */
async function recordTurn(
  messages: AgentMessage[],
  filePath: string,
): Promise<CacheTraceEvent> {
  const engine = createContextEngine(pipelineConfig, makeDeps());
  const assembled = await engine.transformContext(messages);

  const trace = makeTrace(filePath);
  const wrapped = buildCacheTraceWrapper(trace)(fakeNext);
  wrapped(
    fakeModel() as Parameters<StreamFn>[0],
    { messages: assembled, systemPrompt: "you are an assistant" } as Parameters<StreamFn>[1],
  );
  await trace.flush();

  const sc = readLines(filePath).find((l) => l.stage === "stream:context");
  if (sc === undefined) throw new Error("no stream:context line recorded");
  return sc;
}

/** Extract concatenated text from a pi-ai completion (numbers/answer never logged). */
function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += String((part as Record<string, unknown>).text);
      }
    }
  }
  return text;
}

describe.skipIf(!COMIS_LCD_REGRESSION)("real-LLM regression (/v1)", () => {
  // Provider-backed probes nest on the answer-model env. Absent any -> it.skip.
  const haveAnswer = !!ANSWER_PROVIDER && !!ANSWER_MODEL && !!ANSWER_API_KEY;
  // Cost-bound: when set to 0 the provider call is skipped (record-only).
  const probeLimit =
    COMIS_LCD_LIMIT !== undefined && COMIS_LCD_LIMIT.length > 0
      ? Math.max(0, Number.parseInt(COMIS_LCD_LIMIT, 10) || 0)
      : undefined;

  it.skipIf(!haveAnswer)(
    "tool-free baseline records stream:context against a real provider",
    async () => {
      // Resolve the answer model lane (the getModel guard — memory-review-job.ts:331).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/modelId strings
      const answerModel = getModel(ANSWER_PROVIDER as any, ANSWER_MODEL as any);

      // 1. REAL provider call — proves the driver reaches a live LLM when enabled.
      //    The operator key is forwarded to pi-ai's typed `apiKey` option (the only
      //    way to authenticate the call); it is NEVER stored, logged, or echoed.
      //    Skipped when COMIS_LCD_LIMIT=0 (record-only, $0).
      let answerTokens = 0;
      let answerMs = 0;
      if (probeLimit === undefined || probeLimit > 0) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        const start = performance.now();
        try {
          const resp = await completeSimple(
            answerModel,
            {
              systemPrompt: "you are a terse assistant",
              messages: [
                { role: "user" as const, content: "Reply with the single word: ok", timestamp: Date.now() },
              ],
            },
            { apiKey: ANSWER_API_KEY, temperature: 0.0, maxTokens: 16, signal: controller.signal },
          );
          answerMs = Math.round(performance.now() - start);
          // Read the text to confirm a non-empty completion; numbers only escape.
          const answerText = extractResponseText(resp as { content?: unknown[] });
          expect(answerText.length).toBeGreaterThan(0);
          const usage = (resp as { usage?: { totalTokens?: number } }).usage;
          answerTokens = typeof usage?.totalTokens === "number" ? usage.totalTokens : 0;
        } finally {
          clearTimeout(timer);
        }
      }

      // 2. Assemble the tool-free turn through the pipeline + wrapper, record O2.
      const baseline = await recordTurn(
        [userMsg("hello"), assistantTextMsg("world")],
        join(tmpDir, "baseline.jsonl"),
      );

      // stream:context recorded with messageRoles + the assembledShape descriptor.
      expect(baseline.messageRoles).toBeDefined();
      expect(baseline.assembledShape).toBeDefined();
      // A tool-free turn carries no tool_result.
      expect(baseline.assembledShape!.hasToolResult).toBe(false);
      expect(baseline.assembledShape!.totalCount).toBeGreaterThan(0);

      // Structured metrics ONLY (counts + durations) — never a key or an answer.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          probe: "tool-free-baseline",
          driver: DRIVER_VERSION,
          provider: ANSWER_PROVIDER,
          modelId: ANSWER_MODEL,
          answerTokens,
          answerMs,
          assembledTotalCount: baseline.assembledShape!.totalCount,
          hasToolResult: baseline.assembledShape!.hasToolResult,
        }),
      );
    },
  );

  it.skipIf(!haveAnswer)(
    "single-read probe records stream:context with toolResult and array growth",
    async () => {
      // Turn 1: the tool-free baseline (assembled array length N).
      const baseline = await recordTurn(
        [userMsg("hello"), assistantTextMsg("world")],
        join(tmpDir, "baseline.jsonl"),
      );

      // Turn 2: a forced single-read tool turn — user -> assistant-with-tool_use
      // -> toolResult -> assistant. (Phase 128 adds the <=2-reads loop assertion;
      // here we only stand up the probe + record O2 against the real shape.)
      const singleRead = await recordTurn(
        [
          userMsg("read the file"),
          assistantWithToolUse("tu_1", "read"),
          toolResultMsg("tu_1"),
          assistantTextMsg("done"),
        ],
        join(tmpDir, "single-read.jsonl"),
      );

      // (presence) the tool turn records a toolResult.
      expect(singleRead.messageRoles).toContain("toolResult");
      expect(singleRead.assembledShape).toBeDefined();
      expect(singleRead.assembledShape!.hasToolResult).toBe(true);

      // (pairing) every recorded toolResultId has a matching toolUseId — no orphan.
      expect(singleRead.assembledShape!.toolResultIds.length).toBeGreaterThan(0);
      for (const rid of singleRead.assembledShape!.toolResultIds) {
        expect(singleRead.assembledShape!.toolUseIds).toContain(rid);
      }

      // (growth) the tool turn's assembled array GREW vs the baseline turn.
      expect(baseline.assembledShape).toBeDefined();
      expect(singleRead.assembledShape!.totalCount).toBeGreaterThan(
        baseline.assembledShape!.totalCount,
      );

      // Structured metrics ONLY (counts) — never a key or a model answer.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          probe: "single-read",
          driver: DRIVER_VERSION,
          baselineTotalCount: baseline.assembledShape!.totalCount,
          toolTurnTotalCount: singleRead.assembledShape!.totalCount,
          hasToolResult: singleRead.assembledShape!.hasToolResult,
          toolUseIds: singleRead.assembledShape!.toolUseIds.length,
          toolResultIds: singleRead.assembledShape!.toolResultIds.length,
        }),
      );
    },
  );
});
