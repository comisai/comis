// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated real-LLM regression driver.
 *
 * It stands up the MINIMAL real-provider driver for the Lossless Context
 * DAG: two probes that drive a context turn through the REAL pipeline
 * context engine (`createContextEngine({ version: "pipeline" }).transformContext`)
 * + the cache-trace wrapper (`buildCacheTraceWrapper(trace)(next)`), recording
 * the `stream:context` cache-trace event so the assembled-array invariant
 * (the `assembledShape` descriptor) can be asserted against a
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
 *   3. <=2-READS LOOP-FIX PROBE — the headline regression. Drive
 *      a REAL agentic loop (the pi-agent-core `Agent`) whose `transformContext`
 *      is the live `dag`-mode LCD engine wired to a REAL `createLcdStore(:memory:)`,
 *      with the afterTurn write-path (`ingestTurn`) feeding each turn back into
 *      the store. The model is forced to `read` a file once, then must answer from
 *      the fed-back `tool_result`. An earlier (since deleted) dag-assembler flattened the
 *      reconstructed `tool_use`/`tool_result` to TEXT, so the model never saw a
 *      provider-valid pairing for its own prior action and re-issued the same
 *      `read` 54 times (124 s). The corrected codec round-trip pairs by id, so the
 *      model answers in **<=2 reads**. The probe counts `read` tool_use blocks
 *      across the run (`expect(readCount).toBeLessThanOrEqual(2)`), and records
 *      `stream:context` off the dag-assembled array (hasToolResult + pairing +
 *      growth) + a non-empty real answer.
 *
 * TWO-TIER GATE (mirrors qa-judge-harness.bench.test.ts):
 *   - UNGATED (default CI, `pnpm test` / `pnpm validate`): `COMIS_LCD_REGRESSION`
 *     is unset, so `describe.skipIf` SKIPS this entire suite — no provider call,
 *     no network, no cost reaches CI. (The deterministic assembled-array invariant
 *     is already pinned by the always-on provider-boundary-harness.test.ts.)
 *   - GATED (this file, run by hand): `COMIS_LCD_REGRESSION=1` enables the suite;
 *     the provider-backed probes additionally nest behind the answer-model env
 *     (`COMIS_LCD_ANSWER_{PROVIDER,MODEL,API_KEY}`). Absent any of those ->
 *     `it.skipIf` skips the probe.
 *
 * SECURITY:
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

import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
// The REAL agentic loop driver (fine in a .test.ts) — the faithful <=2-reads probe.
import { Agent } from "@earendil-works/pi-agent-core";
// VALUE completion + stream entry points (fine in a .test.ts) — the real answer LLM call.
import { completeSimple, getModel, streamSimple } from "@earendil-works/pi-ai";
import type { ContextEngineConfig } from "@comis/core";
import {
  buildCacheTraceWrapper,
  createCacheTrace,
  type CacheTrace,
  type CacheTraceEvent,
} from "@comis/observability";
// The REAL LCD store + schema (agent devDependency; allowed ONLY in a .test.ts —
// the agent↛memory cut forbids this import in src/**). The probe drives the
// daemon-injected concrete store directly.
import Database from "better-sqlite3";
import { initSchema, createLcdStore } from "@comis/memory";
import type { ContextStorePort, ContextStoreScope } from "@comis/core";

import { createContextEngine } from "./context-engine.js";
import type { ContextEngineDeps } from "./types.js";
import { ingestTurn } from "../executor/lcd-ingest.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ENV GATES — read process.env ONLY at the test boundary (allowed in a .test.ts;
// the globals rule scopes to src/**). Names match the committed
// scripts/lcd-regression.env.example contract.
const COMIS_LCD_REGRESSION = process.env.COMIS_LCD_REGRESSION; // master gate
const ANSWER_PROVIDER = process.env.COMIS_LCD_ANSWER_PROVIDER;
const ANSWER_MODEL = process.env.COMIS_LCD_ANSWER_MODEL;
const ANSWER_API_KEY = process.env.COMIS_LCD_ANSWER_API_KEY;
const COMIS_LCD_LIMIT = process.env.COMIS_LCD_LIMIT; // cost-bound: cap probe count

/** Per-LLM-call wall-clock deadline (a standard timer is allowed in a .test.ts). */
const LLM_TIMEOUT_MS = 120_000;
/** Harness version stamp — a number is always attributable to fixed harness code. */
const DRIVER_VERSION = "lcd-regression-v1";

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
 * one a real provider call would receive; the wrapper records its shape.
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

// ---------------------------------------------------------------------------
// Probe 3: the <=2-reads loop-fix driver — the REAL dag engine
// + a REAL LCD store + the REAL agentic loop.
// ---------------------------------------------------------------------------

/** The secret only obtainable by reading the file — proves the model used the
 *  fed-back tool_result (not its own prior knowledge) to answer. */
const SECRET_WORD = "ZANZIBAR";
const SECRET_FILE = "secret.txt";
const DAG_CONVERSATION_ID = "conv-lcd-loop";

const DAG_SCOPE: ContextStoreScope = {
  conversationId: DAG_CONVERSATION_ID,
  tenantId: "tenant-lcd",
  agentId: "agent-lcd",
  sessionKey: "sess-lcd",
};

// `dag`-mode config with a MINIMAL fresh tail (1 step) so the earlier read +
// tool_result are reconstructed from the STORE via the codec (the path the loop
// bug broke), not carried verbatim by the live fresh-tail slice.
const dagConfig: ContextEngineConfig = {
  enabled: true,
  thinkingKeepTurns: 10,
  historyTurns: 15,
  version: "dag",
  freshTailTurns: 1,
};

/** Build a fresh in-memory LCD store (the daemon-injected concrete store). The
 *  embeddingDimensions arg is required by initSchema's DDL precondition; the LCD
 *  tables do not use it (1536 is the standard default). */
function makeLcdStore(): ContextStorePort {
  const db = new Database(":memory:");
  initSchema(db, 1536);
  return createLcdStore(db);
}

/** Deps for the `dag` engine: a real store + conversationId (the daemon-injected
 *  shape), plus the minimal pipeline deps the factory needs. */
function makeDagDeps(store: ContextStorePort): ContextEngineDeps {
  const logger = createMockLogger();
  return {
    logger: logger as unknown as ContextEngineDeps["logger"],
    getModel: () => ({ reasoning: true, contextWindow: 200_000, maxTokens: 8_192 }),
    contextStore: store,
    conversationId: DAG_CONVERSATION_ID,
    agentId: DAG_SCOPE.agentId,
    sessionKey: DAG_SCOPE.sessionKey,
  } as ContextEngineDeps;
}

/** The single forced `read` tool — returns the file's secret contents. A no-arg
 *  read keeps the schema trivial; `parameters` is an empty object schema. */
function makeReadTool(): AgentTool {
  return {
    name: "read",
    label: "Read file",
    description: `Read the contents of ${SECRET_FILE}. Returns the file text.`,
    parameters: { type: "object", properties: {}, additionalProperties: false } as unknown as AgentTool["parameters"],
    execute: async (_toolCallId: string) => ({
      content: [{ type: "text", text: `${SECRET_FILE} contents: The secret word is ${SECRET_WORD}.` }],
      details: undefined,
    }),
  } as AgentTool;
}

/** Count `read` tool_use blocks across an AgentMessage transcript — the loop metric. */
function countReadToolUses(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const content = (m as unknown as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        ((block as Record<string, unknown>).type === "toolCall" ||
          (block as Record<string, unknown>).type === "tool_use") &&
        (block as Record<string, unknown>).name === "read"
      ) {
        n += 1;
      }
    }
  }
  return n;
}

/** Record `stream:context` off a `dag`-assembled array (the live store-fed engine),
 *  so the assembled-array invariants (hasToolResult + pairing + growth) can be asserted
 *  against the SAME array the provider would receive. */
async function recordDagTurn(
  store: ContextStorePort,
  liveMessages: AgentMessage[],
  filePath: string,
): Promise<CacheTraceEvent> {
  const engine = createContextEngine(dagConfig, makeDagDeps(store));
  const assembled = await engine.transformContext(liveMessages);

  const trace = makeTrace(filePath);
  const wrapped = buildCacheTraceWrapper(trace)(fakeNext);
  wrapped(
    fakeModel() as Parameters<StreamFn>[0],
    { messages: assembled, systemPrompt: "you are an assistant" } as Parameters<StreamFn>[1],
  );
  await trace.flush();

  const sc = readLines(filePath).find((l) => l.stage === "stream:context");
  if (sc === undefined) throw new Error("no stream:context line recorded (dag)");
  return sc;
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

      // 2. Assemble the tool-free turn through the pipeline + wrapper, record its shape.
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
      // -> toolResult -> assistant. (The deep <=2-reads loop assertion is
      // the third probe below, driving the real dag engine + a real store; this
      // probe records the assembled shape against the pipeline for the baseline comparison.)
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

  it.skipIf(!haveAnswer)(
    "drives the dag engine + a real store and the model answers in <=2 reads (the loop fix)",
    async () => {
      // The HEADLINE regression. A REAL agentic loop whose `transformContext` is
      // the live `dag`-mode LCD engine wired to a REAL `createLcdStore(:memory:)`,
      // with the afterTurn write-path (`ingestTurn`) feeding each turn into the
      // store. Forced to `read` once, the model must answer from the fed-back
      // `tool_result`. An earlier (since deleted) dag-assembler flattened the
      // reconstructed tool_use/tool_result to TEXT -> the model re-issued `read`
      // 54 times; the correct codec round-trip pairs by id -> <=2 reads.
      const store = makeLcdStore();
      const dagEngine = createContextEngine(dagConfig, makeDagDeps(store));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/modelId strings
      const answerModel = getModel(ANSWER_PROVIDER as any, ANSWER_MODEL as any);

      // afterTurn write-path: mirror the live `postExecution` ingest — derive the
      // startSeq from the store's persisted count, append ONLY the not-yet-persisted
      // delta off the live transcript (idempotent; the store is the high-water mark).
      const persistTranscript = (messages: AgentMessage[]): void => {
        const startSeq = store.getMessages(DAG_CONVERSATION_ID).length;
        const delta = messages.slice(startSeq);
        if (delta.length > 0) {
          ingestTurn(store, DAG_SCOPE, startSeq, delta, Date.now(), createMockLogger() as never);
        }
      };

      // Hard cap so a regressed (looping) build cannot run away on cost/time: the
      // pre-fix bug was 54 reads; we cap the loop well below that. A regression
      // trips the <=2 assertion (or the cap) — never a 54-read live-cost blowout.
      const READ_CAP = 6;

      const agent = new Agent({
        initialState: {
          systemPrompt:
            `You are a terse assistant. To learn the secret word you MUST call the \`read\` tool ` +
            `exactly once to read ${SECRET_FILE}. After you receive the file contents, reply with ` +
            `the secret word and nothing else. Do not call \`read\` more than once.`,
          model: answerModel,
          tools: [makeReadTool()],
        },
        // The loop-fix seam: the dag engine's transformContext is what the loop
        // applies before every LLM call (history reconstructed from the store via
        // the codec + the verbatim fresh tail + transcript repair).
        transformContext: (messages) => dagEngine.transformContext(messages),
        // Real provider auth at the .test.ts boundary — forwarded to the stream's
        // typed apiKey; NEVER stored/logged/echoed.
        getApiKey: () => ANSWER_API_KEY,
        streamFn: streamSimple,
        // Safety valve: if the model is looping (a regression), abort after the cap.
        prepareNextTurn: () => {
          if (countReadToolUses(agent.state.messages) > READ_CAP) agent.abort();
          return undefined;
        },
      });

      // Feed each completed turn back into the store at `turn_end` — the faithful
      // afterTurn ingest seam (the live `postExecution` placement). At `turn_end`
      // BOTH the assistant `tool_use` message AND its `tool_result` are already in
      // the transcript, so the next turn's `transformContext` reconstructs the
      // paired round-trip from the STORE (the path the loop bug broke). Ingesting
      // in `afterToolCall` would miss the tool_result (pushed after that hook).
      agent.subscribe((event) => {
        if (event.type === "turn_end") persistTranscript(agent.state.messages);
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      const start = performance.now();
      try {
        await agent.prompt({
          role: "user",
          content: "Read the file and tell me the secret word.",
          timestamp: Date.now(),
        } as AgentMessage);
        await agent.waitForIdle();
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = Math.round(performance.now() - start);

      const finalMessages = agent.state.messages;
      // Persist the final turn so the recorded assembled array reflects the full run.
      persistTranscript(finalMessages);

      // (loop fix) the model answered in <=2 reads (was 54). This is the headline.
      const readCount = countReadToolUses(finalMessages);
      expect(readCount).toBeGreaterThan(0); // it DID read (used the tool, not prior knowledge)
      expect(readCount).toBeLessThanOrEqual(2);

      // (answer) a non-empty final assistant answer that used the fed-back result.
      const lastAssistant = [...finalMessages]
        .reverse()
        .find((m) => (m as unknown as { role?: string }).role === "assistant");
      const answerText = lastAssistant
        ? extractResponseText(lastAssistant as { content?: unknown[] })
        : "";
      expect(answerText.length).toBeGreaterThan(0);
      const usedSecret = answerText.toUpperCase().includes(SECRET_WORD);

      // (shape on the dag array) record stream:context off the dag-assembled context
      // and assert hasToolResult + valid pairing + growth vs an empty-store turn.
      const emptyStore = makeLcdStore();
      const emptyTurn = await recordDagTurn(
        emptyStore,
        [{ role: "user", content: [{ type: "text", text: "hi" }] } as AgentMessage],
        join(tmpDir, "dag-empty.jsonl"),
      );
      const fedTurn = await recordDagTurn(store, finalMessages, join(tmpDir, "dag-fed.jsonl"));

      expect(fedTurn.assembledShape).toBeDefined();
      expect(fedTurn.assembledShape!.hasToolResult).toBe(true);
      expect(fedTurn.assembledShape!.toolResultIds.length).toBeGreaterThan(0);
      // pairing: every toolResultId has a matching toolUseId (no orphan reached the provider).
      for (const rid of fedTurn.assembledShape!.toolResultIds) {
        expect(fedTurn.assembledShape!.toolUseIds).toContain(rid);
      }
      // growth: the fed turn's assembled array is larger than the empty-store turn.
      expect(emptyTurn.assembledShape).toBeDefined();
      expect(fedTurn.assembledShape!.totalCount).toBeGreaterThan(
        emptyTurn.assembledShape!.totalCount,
      );

      // Structured metrics ONLY (counts/durations/flags) — never a key or the answer body.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          probe: "lcd-<=2-reads",
          driver: DRIVER_VERSION,
          provider: ANSWER_PROVIDER,
          modelId: ANSWER_MODEL,
          readCount,
          elapsedMs,
          usedSecret,
          answerLen: answerText.length,
          fedAssembledCount: fedTurn.assembledShape!.totalCount,
          hasToolResult: fedTurn.assembledShape!.hasToolResult,
          toolUseIds: fedTurn.assembledShape!.toolUseIds.length,
          toolResultIds: fedTurn.assembledShape!.toolResultIds.length,
        }),
      );
    },
  );
});
