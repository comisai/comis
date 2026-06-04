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
});
