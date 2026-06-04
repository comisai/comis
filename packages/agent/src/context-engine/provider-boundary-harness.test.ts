// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-boundary fake-provider harness — the PERMANENT regression gate
 * for the assembled provider array (O2).
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
 * The growth + pairing assertions ride the `assembledShape` field added in
 * Plan 126-05 Task 2 — so on pre-patch code (before the field + emit exist)
 * `assembledShape` is `undefined` and these assertions FAIL (RED). They flip
 * GREEN once the schema field + wrapper emit land.
 *
 * Phases 127-133 assert against this gate. Keep ALL harness logic in this
 * `.test.ts` (Pitfall 4: a never-imported `.ts` source counts 0% in the full
 * coverage run and trips the agent per-package floor).
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

describe("provider-boundary harness — assembled array invariants (O2)", () => {
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

  // ── WR-01: high-tool-count turn — the pairing/orphan signal must SURVIVE the
  //    64-item sanitizeForPersistence array cap. ──────────────────────────────
  //
  // `assembledShape.toolUseIds` / `toolResultIds` are NOT in the cache-trace
  // exempt set (correct — they must stay bounded). On pre-patch code those are
  // plain unbounded arrays, so a turn assembling >64 tool_use / tool_result
  // blocks serializes them as a `{ __bounded__: "bounded-payload-array-length-
  // limit", originalLength: N }` SENTINEL in the JSONL — and every downstream
  // pairing/orphan check that iterates `toolResultIds` / indexes `toolUseIds`
  // becomes a silent no-op exactly on the largest, highest-risk turns. The fix
  // self-bounds the id arrays at the source AND carries count fields
  // (`toolUseCount` / `toolResultCount` / `pairedToolResultCount`) that never
  // vanish under the bound, so the gate asserts on counts instead of reading
  // through a sentinel.
  //
  // Reads the raw JSONL as an untyped record so the test compiles against BOTH
  // pre- and post-patch schemas; it FAILS on pre-patch behavior (sentinel +
  // missing count fields), GREEN once the descriptor self-bounds.
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
