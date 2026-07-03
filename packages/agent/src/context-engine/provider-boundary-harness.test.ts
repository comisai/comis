// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-boundary fake-provider harness — the PERMANENT regression gate
 * for the assembled provider array.
 *
 * This harness drives a tool turn through the REAL pipeline context engine
 * (`createContextEngine({ ...config, version: "pipeline" }).transformContext`)
 * and feeds the assembled array into the cache-trace wrapper
 * (`buildCacheTraceWrapper(trace)(next)`), then reads the recorded
 * `stream:context` JSONL line back and asserts the assembled-array SHAPE:
 *
 *   - the multi-step tool turn's recorded array contains a `toolResult`
 *     (the demolished DAG loop bug silently DROPPED tool_use/tool_result —
 *     this gate makes reintroducing that impossible);
 *   - every recorded `toolResultId` has a matching `toolUseId` (pairing,
 *     no orphan);
 *   - the tool turn's assembled array GROWS vs the prior short turn
 *     (totalCount strictly increases).
 *
 * The growth + pairing assertions ride the `assembledShape` field the
 * cache-trace wrapper records — if the schema field or the wrapper emit is
 * ever removed, `assembledShape` is `undefined` and these assertions fail.
 *
 * Keep ALL harness logic in this `.test.ts` (a never-imported `.ts` source
 * counts 0% in the full coverage run and trips the agent per-package floor).
 *
 * Precedents copied verbatim:
 *   - makeTrace / readLines / fake `next: StreamFn`:
 *     packages/observability/src/cache-trace/stream-fn-wrapper.test.ts
 *   - createMockDeps + message-shape builders:
 *     packages/agent/src/context-engine/context-engine.test.ts
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
import type { Message } from "@earendil-works/pi-ai";
import type {
  AppendMessageInput,
  ContextEngineConfig,
  ContextStorePort,
  ContextStoreScope,
} from "@comis/core";
import { messageToParts } from "@comis/core";
import Database from "better-sqlite3";
import { createLcdStore, initSchema } from "@comis/memory";
import {
  buildCacheTraceWrapper,
  createCacheTrace,
  type CacheTrace,
  type CacheTraceEvent,
} from "@comis/observability";

import { createContextEngine } from "./context-engine.js";
import type { ContextEngine, ContextEngineDeps } from "./types.js";
import { estimateMessageTokens } from "../safety/token-estimator.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-provider-boundary-harness-"));
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
//     assembledShape descriptor must be present regardless. ---
function makeTrace(filePath: string): CacheTrace {
  const trace = createCacheTrace({
    enabled: true,
    filePath,
    includeMessages: false,
    includePrompt: true,
    includeSystem: true,
    agentId: "agent-1",
    sessionId: "sid-1",
  });
  if (trace === null) throw new Error("makeTrace returned null");
  return trace;
}

// --- fake model + fake StreamFn (stream-fn-wrapper.test.ts:64-96). The fake
//     returns a bare object so the wrapper's "no .result() function" fallback
//     fires (no real pi-ai stack). ---
function fakeModel(): unknown {
  return { provider: "anthropic", id: "claude-3-opus" };
}

const fakeNext: StreamFn = ((..._args: unknown[]) =>
  ({}) as ReturnType<StreamFn>) as StreamFn;

// --- Minimal deps fixture (context-engine.test.ts:44-59). A reasoning model
//     so the full pipeline runs; the layers are no-ops on these tiny inputs. ---
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

// --- Message-shape builders (context-engine.test.ts:638-651,1071-1126,1969-1974).
//     Cast `as AgentMessage` like the existing tests. ---
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
 * Drive a raw message array straight through the cache-trace wrapper (no
 * pipeline), read back the recorded `stream:context` line. Used by the
 * high-tool-count case: it isolates the `assembledShape` descriptor's
 * bounding behavior from the pipeline's history-window logic, so the
 * assertion is purely about whether the pairing/count signal survives the
 * 64-item sanitizeForPersistence array cap.
 */
async function recordRawTurn(
  messages: AgentMessage[],
  filePath: string,
): Promise<CacheTraceEvent> {
  const trace = makeTrace(filePath);
  const wrapped = buildCacheTraceWrapper(trace)(fakeNext);
  wrapped(
    fakeModel() as Parameters<StreamFn>[0],
    { messages, systemPrompt: "you are an assistant" } as Parameters<StreamFn>[1],
  );
  await trace.flush();
  const sc = readLines(filePath).find((l) => l.stage === "stream:context");
  if (sc === undefined) throw new Error("no stream:context line recorded");
  return sc;
}

/**
 * Drive one turn through the real pipeline engine + the cache-trace wrapper,
 * read back the recorded `stream:context` line.
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

/**
 * Drive one turn through an ALREADY-BUILT engine (e.g. the `dag`-mode LCD
 * engine) + the cache-trace wrapper, read back the recorded `stream:context`
 * line. Mirrors `recordTurn` but takes the engine as an argument instead of
 * constructing the pipeline engine — so the same record-and-read mechanism
 * exercises the LCD assembly. The pipeline path (`recordTurn`) is untouched.
 */
async function recordTurnWith(
  engine: ContextEngine,
  messages: AgentMessage[],
  filePath: string,
): Promise<CacheTraceEvent> {
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

// --- dag-mode (LCD) fixtures + store helpers ───────────────────────────────
//
// The dag engine reads HISTORY from an injected ContextStorePort + the FRESH
// TAIL from the live `transformContext` arg. To exercise it we
// build canonical pi-ai messages (`toolCall` blocks + top-level `toolResult`
// messages — the shapes the core `messageToParts`/`partsToMessage` codec
// round-trips faithfully, matching the real SDK loop) and persist them to a
// real `createLcdStore(:memory:)` via the codec, exactly as the afterTurn
// ingest path would. The harness's pipeline fixtures above use
// the `tool_use`/top-level-toolResult AgentMessage casts — DISTINCT shapes for
// the DISTINCT path; we keep the codec-faithful canonical builders here.

const DAG_CONVERSATION_ID = "conv-dag-1";
const DAG_CREATED_AT = 1000;

const dagScope: ContextStoreScope = {
  conversationId: DAG_CONVERSATION_ID,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "sess-a",
};

function dagUserMsg(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: DAG_CREATED_AT } as unknown as AgentMessage;
}

function dagAssistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "stop",
    timestamp: DAG_CREATED_AT,
  } as unknown as AgentMessage;
}

function dagAssistantToolCall(id: string, name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "toolUse",
    timestamp: DAG_CREATED_AT,
  } as unknown as AgentMessage;
}

function dagToolResult(toolCallId: string, name: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: name,
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: DAG_CREATED_AT,
  } as unknown as AgentMessage;
}

/**
 * Persist a turn into the LCD store the way the afterTurn ingest path does:
 * monotonic `seq` from 0, a full SECURITY scope (no empty column), a fixed
 * `createdAt`, `tokenCount` computed agent-side, and `parts` via the verbatim
 * codec (NEVER flattened to text). The dag engine then reconstructs history
 * from exactly these rows.
 */
function appendTurnToStore(store: ContextStorePort, messages: AgentMessage[]): void {
  messages.forEach((m, seq) => {
    const msg = m as unknown as Message;
    const input: AppendMessageInput = {
      scope: dagScope,
      seq,
      role: msg.role,
      tokenCount: estimateMessageTokens(msg),
      createdAt: DAG_CREATED_AT,
      parts: messageToParts(msg),
    };
    store.append(input);
  });
}

/** Build the live dag-mode LCD engine wired to a store + conversationId. */
function makeDagEngine(store: ContextStorePort, freshTailTurns: number): ContextEngine {
  return createContextEngine(
    { ...pipelineConfig, version: "dag", freshTailTurns } as unknown as ContextEngineConfig,
    // Thread agentId + tenantId so the dag assembler builds the full
    // read scope (matching dagScope's appends) — else it fails closed.
    {
      ...makeDeps(),
      contextStore: store,
      conversationId: DAG_CONVERSATION_ID,
      agentId: dagScope.agentId,
      tenantId: dagScope.tenantId,
      sessionKey: dagScope.sessionKey,
    },
  );
}

describe("provider-boundary harness — assembled array invariants", () => {
  it("tool turn records a toolResult, pairs tool_use<->tool_result, and the array grows", async () => {
    // Turn 1: a short user + assistant exchange.
    const turn1 = await recordTurn(
      [userMsg("hello"), assistantTextMsg("world")],
      join(tmpDir, "turn1.jsonl"),
    );

    // Turn 2: a multi-step tool turn (user -> assistant-with-tool_use ->
    // toolResult -> assistant).
    const turn2 = await recordTurn(
      [
        userMsg("read the file"),
        assistantWithToolUse("tu_1", "read"),
        toolResultMsg("tu_1"),
        assistantTextMsg("done"),
      ],
      join(tmpDir, "turn2.jsonl"),
    );

    // (presence) turn-2 messageRoles contains "toolResult".
    expect(turn2.messageRoles).toContain("toolResult");

    // (presence) turn-2 assembledShape.hasToolResult === true.
    expect(turn2.assembledShape).toBeDefined();
    expect(turn2.assembledShape!.hasToolResult).toBe(true);

    // (pairing) every toolResultId has a matching toolUseId — no orphan.
    expect(turn2.assembledShape!.toolResultIds.length).toBeGreaterThan(0);
    for (const rid of turn2.assembledShape!.toolResultIds) {
      expect(turn2.assembledShape!.toolUseIds).toContain(rid);
    }

    // (growth) the tool turn's assembled array GREW vs the short turn.
    expect(turn1.assembledShape).toBeDefined();
    expect(turn2.assembledShape!.totalCount).toBeGreaterThan(
      turn1.assembledShape!.totalCount,
    );
  });

  // ── Always-on gate (no env, no provider): the SAME presence/pairing/growth
  //    invariants on the LIVE dag-mode LCD assembly, fed by REAL ingested store
  //    rows, driven through the cache-trace wrapper. ──────────────────────────
  //
  // This is the permanent deterministic regression for the loop bug-class: an
  // earlier (since deleted) dag-assembler flattened every tool_use / tool_result
  // to `content:[{type:"text"}]`, so the model never saw a provider-valid
  // pairing for its own prior action and re-issued the same call dozens of
  // times. If the `dag` branch ever falls through to the pipeline with NO
  // faithful toolResult reconstructed from the store, `hasToolResult` is
  // false / the array does not grow → this case fails.
  //
  // It asserts via the SAME `assembledShape` fields as the pipeline case
  // above (one contract — no new block convention), and
  // additionally pins `pairedToolResultCount === toolResultCount` (the
  // orphan-free count signal that survives the 64-item id cap).
  it("dag-mode LCD assembly records a toolResult, pairs tool_use<->tool_result, and the array grows", async () => {
    // The multi-step tool turn the loop bug corrupted: user -> assistant(toolCall
    // tu_1) -> toolResult(tu_1) -> assistant(text). Canonical pi-ai shapes so the
    // codec round-trips them faithfully.
    const toolTurn: AgentMessage[] = [
      dagUserMsg("read the file"),
      dagAssistantToolCall("tu_1", "read"),
      dagToolResult("tu_1", "read"),
      dagAssistantText("done"),
    ];

    // ── Sub-case A: the whole short turn rides the FRESH TAIL (freshTailTurns=8
    //    default ⇒ the live array IS the fresh tail), proving the assembler
    //    emits a paired + growing array end-to-end. ──────────────────────────
    const dbA = new Database(":memory:");
    initSchema(dbA, 1536);
    const storeA = createLcdStore(dbA);
    appendTurnToStore(storeA, toolTurn);
    const engineA = makeDagEngine(storeA, 8);

    // Baseline turn1: a tool-free user + assistant exchange (its own store/DB so
    // history is just the short text turn).
    const dbBaseline = new Database(":memory:");
    initSchema(dbBaseline, 1536);
    const storeBaseline = createLcdStore(dbBaseline);
    const textTurn: AgentMessage[] = [dagUserMsg("hello"), dagAssistantText("world")];
    appendTurnToStore(storeBaseline, textTurn);
    const engineBaseline = makeDagEngine(storeBaseline, 8);

    const turn1 = await recordTurnWith(
      engineBaseline,
      textTurn,
      join(tmpDir, "dag-turn1.jsonl"),
    );
    const turn2 = await recordTurnWith(engineA, toolTurn, join(tmpDir, "dag-turn2.jsonl"));

    // (presence) the dag tool turn's recorded array carries a top-level toolResult.
    expect(turn2.messageRoles).toContain("toolResult");
    expect(turn2.assembledShape).toBeDefined();
    expect(turn2.assembledShape!.hasToolResult).toBe(true);

    // (pairing) every toolResultId has a matching toolUseId (no orphan) AND
    // the orphan-free count signal holds (survives the 64-item id cap).
    expect(turn2.assembledShape!.toolResultIds.length).toBeGreaterThan(0);
    for (const rid of turn2.assembledShape!.toolResultIds) {
      expect(turn2.assembledShape!.toolUseIds).toContain(rid);
    }
    expect(turn2.assembledShape!.pairedToolResultCount).toBe(
      turn2.assembledShape!.toolResultCount,
    );

    // (growth) the tool turn's assembled array GREW vs the short text turn.
    expect(turn1.assembledShape).toBeDefined();
    expect(turn2.assembledShape!.totalCount).toBeGreaterThan(
      turn1.assembledShape!.totalCount,
    );

    // ── Sub-case B: exercise the CODEC READ path — with freshTailTurns=1 only
    //    the trailing assistant("done") is the fresh tail, so the tu_1 tool_use
    //    + its toolResult fall in the history prefix [0,tailStart), which the
    //    assembler reconstructs from the STORE rows (the codec round-trip), NOT
    //    from the live array's tail. The live array is the FULL conversation
    //    (the SDK passes `state.messages`, never a tail-only slice); with
    //    freshTailTurns=1 the boundary lands at the trailing assistant so the
    //    earlier tu_1 step is store-sourced. The pairing + presence invariants
    //    must STILL hold — this is the round-trip the flatten-to-text loop bug
    //    broke. ─────────────────────────────────────────────────────────────
    const dbB = new Database(":memory:");
    initSchema(dbB, 1536);
    const storeB = createLcdStore(dbB);
    appendTurnToStore(storeB, toolTurn);
    const engineB = makeDagEngine(storeB, 1);

    const turnFromHistory = await recordTurnWith(
      engineB,
      toolTurn, // full conversation live; history prefix [0,3) is store-sourced
      join(tmpDir, "dag-from-history.jsonl"),
    );

    expect(turnFromHistory.assembledShape).toBeDefined();
    // The toolResult was reconstructed from the store (it is NOT in the live
    // array) — proving the codec read path keeps the pairing intact.
    expect(turnFromHistory.assembledShape!.hasToolResult).toBe(true);
    expect(turnFromHistory.assembledShape!.toolResultIds.length).toBeGreaterThan(0);
    for (const rid of turnFromHistory.assembledShape!.toolResultIds) {
      expect(turnFromHistory.assembledShape!.toolUseIds).toContain(rid);
    }
    expect(turnFromHistory.assembledShape!.pairedToolResultCount).toBe(
      turnFromHistory.assembledShape!.toolResultCount,
    );
  });

  // ── High-tool-count turn — the pairing/orphan signal must SURVIVE the
  //    64-item sanitizeForPersistence array cap. ──────────────────────────────
  //
  // `assembledShape.toolUseIds` / `toolResultIds` are NOT in the cache-trace
  // exempt set (correct — they must stay bounded). Were those
  // plain unbounded arrays, a turn assembling >64 tool_use / tool_result
  // blocks would serialize them as a `{ __bounded__: "bounded-payload-array-
  // length-limit", originalLength: N }` SENTINEL in the JSONL — and every
  // downstream pairing/orphan check that iterates `toolResultIds` / indexes
  // `toolUseIds` would become a silent no-op exactly on the largest,
  // highest-risk turns. The descriptor therefore
  // self-bounds the id arrays at the source AND carries count fields
  // (`toolUseCount` / `toolResultCount` / `pairedToolResultCount`) that never
  // vanish under the bound, so the gate asserts on counts instead of reading
  // through a sentinel.
  //
  // Reads the raw JSONL as an untyped record (post-sanitization, exactly what
  // landed on disk); it fails if the id arrays arrive as a sentinel or the
  // count fields are missing.
  it("high-tool-count turn keeps the pairing signal under the 64-item array cap", async () => {
    const PAIRS = 80; // > PAYLOAD_BOUNDS.maxArrayLength (64)
    const messages: AgentMessage[] = [userMsg("kick off a big fan-out")];
    for (let i = 0; i < PAIRS; i++) {
      messages.push(assistantWithToolUse(`tu_${i}`, "read"));
      messages.push(toolResultMsg(`tu_${i}`));
    }

    const filePath = join(tmpDir, "fanout.jsonl");
    await recordRawTurn(messages, filePath);

    // Read the recorded line back as a RAW record (post-sanitization, exactly
    // what landed on disk).
    const raw = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.stage === "stream:context");
    expect(raw).toBeDefined();

    const shape = raw!.assembledShape as Record<string, unknown>;
    expect(shape).toBeDefined();

    // (1) the id arrays must NOT have been replaced by a bounded sentinel — the
    //     descriptor self-bounds, so they remain real string arrays (capped).
    expect(Array.isArray(shape.toolUseIds)).toBe(true);
    expect(Array.isArray(shape.toolResultIds)).toBe(true);

    // (2) the count fields survive the bound and reflect the TRUE totals.
    expect(shape.toolUseCount).toBe(PAIRS);
    expect(shape.toolResultCount).toBe(PAIRS);

    // (3) the pairing invariant holds on counts (never vanishes under the cap):
    //     every tool_result is paired with a tool_use → no orphans.
    expect(shape.pairedToolResultCount).toBe(PAIRS);

    // (4) overflow is surfaced honestly, not silently dropped.
    expect(shape.idsTruncated).toBe(true);

    // hasToolResult still true at any turn size.
    expect(shape.hasToolResult).toBe(true);
  });
});
