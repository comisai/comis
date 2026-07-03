// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the three in-session expansion-loop `ctx_*` AgentTools
 * (`ctx_search` / `ctx_inspect` / `ctx_expand`) — the E1 recovery + E2
 * scope/taint/externalize behaviors.
 *
 * Pure-JS / macOS-green: a hand-built `ContextToolDeps` with a stub
 * `ContextStorePort` (only the methods each SUT calls), a fake `nowMs`, a fake
 * `getToolResultsDir` (an os tmpdir), and a recording `ToolLogger` are injected.
 * Per-call scope is driven by `runWithContext({ sessionKey })` so the tool sees
 * a live session (or the absence of one, for the fail-closed test). No real
 * store / FTS / filesystem session dir is touched beyond the tmpdir spill file.
 *
 * These tools are direct-injection (they read the injected `ContextStorePort`),
 * NOT the RPC recall path (session-search / memory-search) — there is ZERO RPC
 * call, recall dispatch, or cross-package memory import here (the E2/I2 boundary).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { Value } from "typebox/value";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  runWithContext,
  type RequestContext,
  type ContextStorePort,
  type ContextStoreScope,
  type LcdSummary,
  type LcdMessage,
  type LcdSearchHit,
  type LcdSearchResult,
  type LcdMessagePart,
} from "@comis/core";

import {
  createCtxSearchTool,
  createCtxInspectTool,
  createCtxExpandTool,
  type ContextToolDeps,
} from "./index.js";
import { sanitizeFts5Query } from "../../../platform-tools/tools/fts5-sanitizer.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

function makeRecordingLogger(): {
  logs: CapturedLog[];
  debug: (o: Record<string, unknown>, m: string) => void;
  info: (o: Record<string, unknown>, m: string) => void;
  warn: (o: Record<string, unknown>, m: string) => void;
  error: (o: Record<string, unknown>, m: string) => void;
} {
  const logs: CapturedLog[] = [];
  return {
    logs,
    debug: (obj, msg) => logs.push({ level: "debug", obj, msg }),
    info: (obj, msg) => logs.push({ level: "info", obj, msg }),
    warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
    error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  };
}

/** Concatenate every value of every recorded log object into one searchable blob. */
function flattenLoggedValues(logs: CapturedLog[]): string {
  return logs
    .map((l) => `${l.msg} ${Object.values(l.obj).map((v) => String(v)).join(" ")}`)
    .join(" ");
}

/** A neutral RequestContext with a live, fully-scoped session (AGENTS.md §2.2). */
function liveCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "default",
    userId: "user_a",
    sessionKey: "default:user_a:chan_a",
    agentId: "agent_a", // the ctx tools read the live agentId per-call, never a wiring closure
    traceId: randomUUID(),
    startedAt: 1_000_000,
    trustLevel: "user",
    contentDelimiter: "test-delimiter-0123456789",
    ...overrides,
  };
}

/** Build a text-only message part (the verbatim block carries the text). */
function textPart(text: string): LcdMessagePart {
  return { kind: "text", metadata: { raw: { type: "text", text }, rawType: "text" } };
}

/** Build a stub LcdMessage with one text part. */
function makeMessage(id: string, seq: number, text: string): LcdMessage {
  return {
    id,
    conversationId: "default:user_a:chan_a",
    seq,
    role: "user",
    tokenCount: 4,
    createdAt: 1_000_000 + seq,
    parts: [textPart(text)],
  };
}

/** Build a stub LcdSummary. */
function makeSummary(overrides: Partial<LcdSummary> = {}): LcdSummary {
  return {
    summaryId: "sum-1",
    conversationId: "default:user_a:chan_a",
    kind: "leaf",
    depth: 0,
    earliestAt: 1_000_001,
    latestAt: 1_000_009,
    descendantCount: 3,
    tokenCount: 42,
    content: "a condensed summary body that is metadata-adjacent",
    fileIds: [],
    taint: false,
    fallback: false,
    createdAt: 1_000_010,
    ...overrides,
  };
}

/**
 * A recording stub of the methods the ctx_* tools call. Only the methods a
 * given SUT touches need to be set; the rest stay no-ops (cast to the port).
 */
interface StoreStub {
  /** Records the FULL ContextStoreScope each searchLcd call received (proves the live-context scope). */
  searchLcdArgs: Array<{ scope: ContextStoreScope; query: string; opts: unknown }>;
  /** Records the scope of every scoped read (getSummaries/Children/Messages/getMessages) for multi-agent assertions. */
  readScopes: ContextStoreScope[];
  searchLcdReturn: LcdSearchHit[];
  cjkZeroHit: boolean;
  /** Widened LcdSearchResult fields the searchLcd stub returns (lane + matchErrored REQUIRED). */
  lane: "word" | "tri" | "scan";
  matchErrored: boolean;
  getSummariesReturn: LcdSummary[];
  getSummaryChildrenReturn: LcdSummary[];
  getSummaryMessagesReturn: string[];
  getMessagesReturn: LcdMessage[];
  /** Records the conversationId of every runOnConversation call (single-flight proof). */
  serializedConversationIds: string[];
}

function makeStore(over: Partial<StoreStub> = {}): { stub: StoreStub; store: ContextStorePort } {
  const stub: StoreStub = {
    searchLcdArgs: [],
    readScopes: [],
    searchLcdReturn: [],
    cjkZeroHit: false,
    lane: "word",
    matchErrored: false,
    getSummariesReturn: [],
    getSummaryChildrenReturn: [],
    getSummaryMessagesReturn: [],
    getMessagesReturn: [],
    serializedConversationIds: [],
    ...over,
  };
  const store = {
    searchLcd(scope: ContextStoreScope, query: string, opts: unknown): LcdSearchResult {
      stub.searchLcdArgs.push({ scope, query, opts });
      return { hits: stub.searchLcdReturn, cjkZeroHit: stub.cjkZeroHit, lane: stub.lane, matchErrored: stub.matchErrored };
    },
    getSummaries(scope: ContextStoreScope): LcdSummary[] {
      stub.readScopes.push(scope);
      return stub.getSummariesReturn;
    },
    getSummaryChildren(scope: ContextStoreScope, _parentSummaryId: string): LcdSummary[] {
      stub.readScopes.push(scope);
      return stub.getSummaryChildrenReturn;
    },
    getSummaryMessages(scope: ContextStoreScope, _summaryId: string): string[] {
      stub.readScopes.push(scope);
      return stub.getSummaryMessagesReturn;
    },
    getMessages(scope: ContextStoreScope): LcdMessage[] {
      stub.readScopes.push(scope);
      return stub.getMessagesReturn;
    },
    // ctx_expand runs its multi-hop walk INSIDE the single-flight serializer so
    // a deferred compaction write cannot rewrite the DAG mid-walk. The stub runs
    // `fn` immediately (no real queue) and records the conversationId so the wrap
    // is asserted at the tool level.
    async runOnConversation<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T> {
      stub.serializedConversationIds.push(conversationId);
      return fn();
    },
  } as unknown as ContextStorePort;
  return { stub, store };
}

function makeDeps(
  store: ContextStorePort,
  over: Partial<ContextToolDeps> = {},
): { deps: ContextToolDeps; logger: ReturnType<typeof makeRecordingLogger> } {
  const logger = makeRecordingLogger();
  const deps: ContextToolDeps = {
    store,
    logger,
    nowMs: () => 1_700_000_000_000,
    maxExpandTokens: 4000,
    getToolResultsDir: () => undefined,
    ...over,
  };
  return { deps, logger };
}

/** Run a tool's execute() inside a live-session scope (or none, when ctx is null). */
async function runExecute(
  tool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> },
  toolCallId: string,
  params: Record<string, unknown>,
  ctx: RequestContext | null,
): Promise<unknown> {
  if (ctx === null) return tool.execute(toolCallId, params);
  return runWithContext(ctx, () => tool.execute(toolCallId, params));
}

// ---------------------------------------------------------------------------
// ctx_search
// ---------------------------------------------------------------------------

describe("ctx_search tool", () => {
  it("ctx_search rejects with permission_denied when there is no active session", async () => {
    const { store } = makeStore();
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    await expect(runExecute(tool, "call-1", { query: "anything" }, null)).rejects.toThrow(
      /permission_denied/,
    );
  });

  it("ctx_search sanitizes the query before calling store.searchLcd", async () => {
    const raw = 'topic "context recovery" AND (lossless OR dag)';
    const { stub, store } = makeStore({
      searchLcdReturn: [{ kind: "message", refId: "m1", snippet: "hit text", rank: -1.2 }],
    });
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    await runExecute(tool, "call-2", { query: raw }, liveCtx());
    expect(stub.searchLcdArgs).toHaveLength(1);
    // The query handed to the store is the SANITIZED form, not the raw input.
    expect(stub.searchLcdArgs[0].query).toBe(sanitizeFts5Query(raw));
    expect(stub.searchLcdArgs[0].query).not.toBe(raw);
    // And it is scoped to the live conversation, never a caller-supplied id.
    expect(stub.searchLcdArgs[0].scope.conversationId).toBe("default:user_a:chan_a");
  });

  it("ctx_search builds its store scope from the live context agentId + tenantId, not a wiring closure (multi-agent safety)", async () => {
    // ONE wired tool, TWO different live RequestContexts → TWO different scopes.
    // The tool must read the LIVE agentId/tenantId per-call (tryGetContext()), not
    // a wiring-time closure that would serve every agent the same scope — the
    // cross-agent leak threat.
    const { stub, store } = makeStore({
      searchLcdReturn: [{ kind: "message", refId: "m1", snippet: "hit", rank: -1 }],
    });
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);

    await runExecute(
      tool,
      "call-A",
      { query: "x" },
      liveCtx({ tenantId: "tenant_one", agentId: "agent-one", sessionKey: "tenant_one:user_a:chan_a" }),
    );
    await runExecute(
      tool,
      "call-B",
      { query: "x" },
      liveCtx({ tenantId: "tenant_two", agentId: "agent-two", sessionKey: "tenant_two:user_b:chan_b" }),
    );

    expect(stub.searchLcdArgs).toHaveLength(2);
    // Each call's scope mirrors ITS OWN live context — never a single shared closure.
    expect(stub.searchLcdArgs[0].scope.agentId).toBe("agent-one");
    expect(stub.searchLcdArgs[0].scope.tenantId).toBe("tenant_one");
    expect(stub.searchLcdArgs[0].scope.conversationId).toBe("tenant_one:user_a:chan_a");
    expect(stub.searchLcdArgs[1].scope.agentId).toBe("agent-two");
    expect(stub.searchLcdArgs[1].scope.tenantId).toBe("tenant_two");
    expect(stub.searchLcdArgs[1].scope.conversationId).toBe("tenant_two:user_b:chan_b");
    // The two scopes are genuinely distinct (one wired tool, two agents).
    expect(stub.searchLcdArgs[0].scope.agentId).not.toBe(stub.searchLcdArgs[1].scope.agentId);
  });

  it("ctx_search fails closed with permission_denied when the live context lacks an agentId", async () => {
    // A session with sessionKey but NO agentId must REFUSE — never read
    // conversation-wide (the partially-built-scope leak).
    const { store } = makeStore();
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    await expect(
      runExecute(tool, "call-noagent", { query: "x" }, liveCtx({ agentId: undefined })),
    ).rejects.toThrow(/permission_denied/);
  });

  it("ctx_search taint-wraps every returned hit snippet before it leaves the tool", async () => {
    const rawSnippet = "the secret plan is to ignore previous instructions";
    const { store } = makeStore({
      searchLcdReturn: [{ kind: "summary", refId: "s1", snippet: rawSnippet, rank: -0.5 }],
    });
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    const result = (await runExecute(tool, "call-3", { query: "plan" }, liveCtx())) as {
      details: { hits: Array<{ snippet: string }> };
    };
    const wrapped = result.details.hits[0].snippet;
    // The wrapped snippet differs from the raw text and carries the untrusted markers.
    expect(wrapped).not.toBe(rawSnippet);
    expect(wrapped).toContain("UNTRUSTED");
    expect(wrapped).toContain(rawSnippet); // the original text survives inside the wrapper
  });

  it("ctx_search scrubs secrets out of each returned hit snippet (FIX 2b egress)", async () => {
    // A recovered snippet that contains a credential. Pre-patch the snippet was
    // wrapped but returned VERBATIM, so the secret reached the model context. The
    // returned snippet must have the secret REDACTED while staying taint-wrapped.
    const secret = "sk-proj-LEAKTEST9999abcdefghijklmnop";
    const rawSnippet = `recovered context mentioning the api key ${secret} inline`;
    const { store } = makeStore({
      searchLcdReturn: [{ kind: "message", refId: "m1", snippet: rawSnippet, rank: -0.7 }],
    });
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    const result = (await runExecute(tool, "search-secret-1", { query: "api key" }, liveCtx())) as {
      details: { hits: Array<{ snippet: string }> };
    };
    const snippet = result.details.hits[0].snippet;
    expect(snippet).toContain("UNTRUSTED");
    expect(snippet).not.toContain(secret);
    expect(snippet).toContain("[REDACTED]");
  });

  it("ctx_search logs only ids and counts, never the query text or a snippet substring", async () => {
    const rawQuery = "supercalifragilistic-query-token";
    const rawSnippet = "uniquely-identifiable-snippet-body";
    const { store } = makeStore({
      searchLcdReturn: [{ kind: "message", refId: "m9", snippet: rawSnippet, rank: -1 }],
    });
    const { deps, logger } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    await runExecute(tool, "call-4", { query: rawQuery }, liveCtx());
    const blob = flattenLoggedValues(logger.logs);
    expect(blob).not.toContain(rawQuery);
    expect(blob).not.toContain(rawSnippet);
    // It DOES record the scope id + a hit count + a step tag.
    const fields = logger.logs.flatMap((l) => Object.keys(l.obj));
    expect(fields).toContain("conversationId");
    expect(fields).toContain("hitCount");
    expect(fields).toContain("step");
  });

  // A real-LLM run surfaced this: the agent picked `limit: 50`, the typebox
  // schema's hard `maximum: 30` REJECTED the call at framework validation (before
  // execute()), and the model got a `[tool failure]` mid-recovery — even though
  // the handler already clamps with `Math.min(Math.max(1, requested), 30)`. The
  // schema must NOT hard-reject an out-of-range integer; the handler is the single
  // clamp authority. LLMs routinely pick round numbers (50/100), so a hard bound
  // turns a recoverable lookup into a failure.
  it("ctx_search accepts an out-of-range limit at schema validation (the handler clamps; the framework must not reject)", () => {
    const { store } = makeStore();
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    // Pre-fix these are FALSE (maximum:30 / minimum:1) → the framework rejects the
    // call before the handler can clamp.
    expect(Value.Check(tool.parameters, { query: "x", limit: 50 })).toBe(true);
    expect(Value.Check(tool.parameters, { query: "x", limit: 0 })).toBe(true);
    // A non-integer is still rejected (the param is an integer count).
    expect(Value.Check(tool.parameters, { query: "x", limit: 3.5 })).toBe(false);
  });

  it("ctx_search clamps an over-/under-range limit to 1..30 before it reaches the store", async () => {
    const { stub, store } = makeStore({ searchLcdReturn: [] });
    const { deps } = makeDeps(store);
    const tool = createCtxSearchTool(deps);
    await runExecute(tool, "call-clamp-hi", { query: "x", limit: 50 }, liveCtx());
    await runExecute(tool, "call-clamp-lo", { query: "x", limit: 0 }, liveCtx());
    expect((stub.searchLcdArgs[0].opts as { limit: number }).limit).toBe(30);
    expect((stub.searchLcdArgs[1].opts as { limit: number }).limit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ctx_inspect
// ---------------------------------------------------------------------------

describe("ctx_inspect tool", () => {
  it("ctx_inspect returns a summary's metadata without taint-wrapping (metadata is not content)", async () => {
    const summary = makeSummary({ summaryId: "sum-7", depth: 1, descendantCount: 5, tokenCount: 99 });
    const { store } = makeStore({ getSummariesReturn: [makeSummary({ summaryId: "other" }), summary] });
    const { deps } = makeDeps(store);
    const tool = createCtxInspectTool(deps);
    const result = (await runExecute(tool, "call-5", { summaryId: "sum-7" }, liveCtx())) as {
      details: Record<string, unknown>;
    };
    const d = result.details;
    expect(d.summaryId).toBe("sum-7");
    expect(d.depth).toBe(1);
    expect(d.descendantCount).toBe(5);
    expect(d.tokenCount).toBe(99);
    // Metadata is returned raw — NOT wrapped as untrusted content.
    expect(JSON.stringify(d)).not.toContain("UNTRUSTED");
  });

  it("ctx_inspect composes child summaryIds and covered message ids from the new store methods", async () => {
    const summary = makeSummary({ summaryId: "sum-parent", kind: "condensed", depth: 1 });
    const { store } = makeStore({
      getSummariesReturn: [summary],
      getSummaryChildrenReturn: [makeSummary({ summaryId: "child-a" }), makeSummary({ summaryId: "child-b" })],
      getSummaryMessagesReturn: ["m1", "m2", "m3"],
    });
    const { deps } = makeDeps(store);
    const tool = createCtxInspectTool(deps);
    const result = (await runExecute(tool, "call-6", { summaryId: "sum-parent" }, liveCtx())) as {
      details: { childSummaryIds: string[]; coveredMessageCount: number };
    };
    expect(result.details.childSummaryIds).toEqual(["child-a", "child-b"]);
    expect(result.details.coveredMessageCount).toBe(3);
  });

  it("ctx_inspect rejects with permission_denied when there is no active session", async () => {
    const { store } = makeStore();
    const { deps } = makeDeps(store);
    const tool = createCtxInspectTool(deps);
    await expect(runExecute(tool, "call-7", { summaryId: "sum-1" }, null)).rejects.toThrow(
      /permission_denied/,
    );
  });
});

// ---------------------------------------------------------------------------
// ctx_expand
// ---------------------------------------------------------------------------

describe("ctx_expand tool", () => {
  it("ctx_expand reconstructs covered messages and taint-wraps the recovered body", async () => {
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1", "m2"],
      getMessagesReturn: [makeMessage("m1", 1, "first recovered line"), makeMessage("m2", 2, "second recovered line")],
    });
    const { deps } = makeDeps(store);
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "call-8", { summaryId: "sum-1" }, liveCtx())) as {
      details: { body?: string; unrecoverable: number };
    };
    expect(result.details.body).toBeDefined();
    expect(result.details.body).toContain("UNTRUSTED");
    expect(result.details.body).toContain("first recovered line");
    expect(result.details.body).toContain("second recovered line");
    expect(result.details.unrecoverable).toBe(0);
  });

  it("ctx_expand skips a drifted message id without throwing and reports an unrecoverable count", async () => {
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1", "m2", "m-gone"],
      getMessagesReturn: [makeMessage("m1", 1, "line one"), makeMessage("m2", 2, "line two")],
    });
    const { deps } = makeDeps(store);
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "call-9", { summaryId: "sum-1" }, liveCtx())) as {
      details: { body?: string; unrecoverable: number };
    };
    // The missing id is skipped, never thrown; coverage is reported as partial.
    expect(result.details.unrecoverable).toBe(1);
    expect(result.details.body).toContain("line one");
    expect(result.details.body).toContain("line two");
  });

  it("ctx_expand spills oversized recovered region to a tool-results file and returns a handle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-expand-spill-"));
    try {
      // Build a body that comfortably exceeds maxExpandTokens (chars/4 heuristic).
      const big = "X".repeat(40_000);
      const { store } = makeStore({
        getSummaryMessagesReturn: ["m1"],
        getMessagesReturn: [makeMessage("m1", 1, big)],
      });
      const { deps } = makeDeps(store, { maxExpandTokens: 100, getToolResultsDir: () => dir });
      const tool = createCtxExpandTool(deps);
      const result = (await runExecute(tool, "spill-call-1", { summaryId: "sum-1" }, liveCtx())) as {
        details: { fullOutputPath?: string; body?: string; unrecoverable: number };
      };
      // The result references a file handle, NOT the full body inline.
      expect(result.details.fullOutputPath).toBeDefined();
      expect(result.details.body).toBeUndefined();
      expect(existsSync(result.details.fullOutputPath as string)).toBe(true);
      // The spilled filename component is the toolCallId (not agent text).
      expect(result.details.fullOutputPath).toContain("spill-call-1");
      const written = readFileSync(result.details.fullOutputPath as string, "utf-8");
      expect(written).toContain(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx_expand scrubs secrets from the externalized file content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-expand-secret-"));
    try {
      // A secret-shaped token embedded in an oversized recovered body.
      const secret = "sk-ant-" + "A".repeat(64);
      const big = "Y".repeat(40_000) + " " + secret;
      const { store } = makeStore({
        getSummaryMessagesReturn: ["m1"],
        getMessagesReturn: [makeMessage("m1", 1, big)],
      });
      const { deps } = makeDeps(store, { maxExpandTokens: 100, getToolResultsDir: () => dir });
      const tool = createCtxExpandTool(deps);
      const result = (await runExecute(tool, "secret-call-1", { summaryId: "sum-1" }, liveCtx())) as {
        details: { fullOutputPath?: string };
      };
      const written = readFileSync(result.details.fullOutputPath as string, "utf-8");
      // The written file content has the secret redacted (scrubSecretsFromText on the file path).
      expect(written).not.toContain(secret);
      expect(written).toContain("[REDACTED]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx_expand scrubs secrets from the INLINE recovered body, not just the spill file (FIX 2a egress)", async () => {
    // A secret in a SMALL recovered region → the inline (non-spill) path. Pre-patch
    // the inline branch returned the recovered body VERBATIM (only the oversized
    // spill branch scrubbed), so a credential reached the model context + every
    // re-injected summary. The inline body must be REDACTED, not verbatim.
    const secret = "sk-proj-LEAKTEST9999abcdefghijklmnop";
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, `recovered line with a credential ${secret} embedded`)],
    });
    const { deps } = makeDeps(store, { maxExpandTokens: 4000, getToolResultsDir: () => undefined });
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "inline-secret-1", { summaryId: "sum-1" }, liveCtx())) as {
      details: { body?: string };
    };
    expect(result.details.body).toBeDefined();
    // Still taint-wrapped, but with the secret scrubbed.
    expect(result.details.body).toContain("UNTRUSTED");
    expect(result.details.body).not.toContain(secret);
    expect(result.details.body).toContain("[REDACTED]");
  });

  it("ctx_expand inlines small recovered output without writing a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-expand-small-"));
    try {
      const { store } = makeStore({
        getSummaryMessagesReturn: ["m1"],
        getMessagesReturn: [makeMessage("m1", 1, "tiny recovered body")],
      });
      const { deps } = makeDeps(store, { maxExpandTokens: 4000, getToolResultsDir: () => dir });
      const tool = createCtxExpandTool(deps);
      const result = (await runExecute(tool, "small-call-1", { summaryId: "sum-1" }, liveCtx())) as {
        details: { fullOutputPath?: string; body?: string };
      };
      // Small output is returned inline (taint-wrapped), no file written.
      expect(result.details.fullOutputPath).toBeUndefined();
      expect(result.details.body).toBeDefined();
      expect(result.details.body).toContain("UNTRUSTED");
      expect(result.details.body).toContain("tiny recovered body");
      // The tmp dir stays empty — nothing spilled.
      expect(existsSync(join(dir, "ctx-expand-small-call-1.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx_expand logs only ids and counts, never the recovered body content", async () => {
    const uniqueBody = "uniquely-identifiable-expand-body-token";
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, uniqueBody)],
    });
    const { deps, logger } = makeDeps(store);
    const tool = createCtxExpandTool(deps);
    await runExecute(tool, "log-call-1", { summaryId: "sum-1" }, liveCtx());
    const blob = flattenLoggedValues(logger.logs);
    expect(blob).not.toContain(uniqueBody);
    const fields = logger.logs.flatMap((l) => Object.keys(l.obj));
    expect(fields).toContain("conversationId");
    expect(fields).toContain("step");
  });

  it("ctx_expand descends a condensed seed multi-hop INSIDE runOnConversation", async () => {
    // A condensed seed (sum-root) → one condensed child (sum-a) → a leaf
    // (sum-a-leaf) → a message. A single-hop expansion would recover
    // ZERO (the seed is condensed, getSummaryMessages(seed) is empty); the
    // multi-hop walk recovers the deep message. Keyed children drive the descent.
    const childrenByParent = new Map<string, LcdSummary[]>([
      ["sum-root", [makeSummary({ summaryId: "sum-a", kind: "condensed", depth: 1 })]],
      ["sum-a", [makeSummary({ summaryId: "sum-a-leaf", kind: "leaf", depth: 0 })]],
    ]);
    const messagesByLeaf = new Map<string, string[]>([["sum-a-leaf", ["deep-m1"]]]);
    const serialized: string[] = [];
    const store = {
      getSummaryChildren(_s: ContextStoreScope, parentId: string): LcdSummary[] {
        return childrenByParent.get(parentId) ?? [];
      },
      getSummaryMessages(_s: ContextStoreScope, summaryId: string): string[] {
        return messagesByLeaf.get(summaryId) ?? [];
      },
      getMessages(_s: ContextStoreScope): LcdMessage[] {
        return [makeMessage("deep-m1", 1, "deep recovered multi-hop detail")];
      },
      async runOnConversation<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T> {
        serialized.push(conversationId);
        return fn();
      },
    } as unknown as ContextStorePort;
    const { deps } = makeDeps(store, { maxExpandDepth: 3 });
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "deep-call-1", { summaryId: "sum-root" }, liveCtx())) as {
      details: { body?: string };
    };
    expect(result.details.body).toContain("deep recovered multi-hop detail");
    // The walk ran inside the single-flight serializer for THIS conversation.
    expect(serialized).toContain("default:user_a:chan_a");
  });
});

// ---------------------------------------------------------------------------
// O1: context:dag_expanded expansion-hit metric (structural eventBus)
// ---------------------------------------------------------------------------

/** The recorded payload keys that MUST NOT carry recovered content (leak ban). */
const CONTENT_FIELDS = ["body", "content", "text", "snippet", "snippets", "hits"];

describe("ctx_* tools emit a content-free context:dag_expanded metric on a hit (O1)", () => {
  it("ctx_expand (inline path) emits context:dag_expanded once with tool/recoveredCount/durationMs, no content", async () => {
    const emit = vi.fn();
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1", "m2"],
      getMessagesReturn: [makeMessage("m1", 1, "first recovered line"), makeMessage("m2", 2, "second recovered line")],
    });
    const { deps } = makeDeps(store, { eventBus: { emit } });
    const tool = createCtxExpandTool(deps);
    await runExecute(tool, "emit-expand-inline", { summaryId: "sum-1" }, liveCtx());

    const calls = emit.mock.calls.filter((c) => c[0] === "context:dag_expanded");
    expect(calls).toHaveLength(1);
    const p = calls[0]![1] as Record<string, unknown>;
    expect(p.tool).toBe("ctx_expand");
    expect(p.recoveredCount).toBe(2); // parts.length
    expect(p.conversationId).toBe("default:user_a:chan_a");
    expect(p.agentId).toBe("agent_a");
    expect(p.sessionKey).toBe("default:user_a:chan_a");
    expect(typeof p.durationMs).toBe("number");
    expect(typeof p.timestamp).toBe("number");
    // Content-leak ban: ids/counts/durations only.
    for (const f of CONTENT_FIELDS) expect(p).not.toHaveProperty(f);
    const blob = JSON.stringify(p);
    expect(blob).not.toContain("first recovered line");
    expect(blob).not.toContain("second recovered line");
  });

  it("ctx_expand (spilled path) emits context:dag_expanded once with recoveredCount = recovered parts, no content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-expand-emit-spill-"));
    try {
      const big = "Z".repeat(40_000);
      const emit = vi.fn();
      const { store } = makeStore({
        getSummaryMessagesReturn: ["m1"],
        getMessagesReturn: [makeMessage("m1", 1, big)],
      });
      const { deps } = makeDeps(store, { maxExpandTokens: 100, getToolResultsDir: () => dir, eventBus: { emit } });
      const tool = createCtxExpandTool(deps);
      await runExecute(tool, "emit-expand-spill", { summaryId: "sum-1" }, liveCtx());

      const calls = emit.mock.calls.filter((c) => c[0] === "context:dag_expanded");
      expect(calls).toHaveLength(1);
      const p = calls[0]![1] as Record<string, unknown>;
      expect(p.tool).toBe("ctx_expand");
      expect(p.recoveredCount).toBe(1);
      expect(JSON.stringify(p)).not.toContain(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx_search emits context:dag_expanded once with tool ctx_search + recoveredCount = hit count, no snippet", async () => {
    const rawSnippet = "uniquely-identifiable-search-snippet";
    const emit = vi.fn();
    const { store } = makeStore({
      searchLcdReturn: [
        { kind: "message", refId: "m1", snippet: rawSnippet, rank: -1 },
        { kind: "summary", refId: "s1", snippet: "another", rank: -0.5 },
      ],
    });
    const { deps } = makeDeps(store, { eventBus: { emit } });
    const tool = createCtxSearchTool(deps);
    await runExecute(tool, "emit-search", { query: "plan" }, liveCtx());

    const calls = emit.mock.calls.filter((c) => c[0] === "context:dag_expanded");
    expect(calls).toHaveLength(1);
    const p = calls[0]![1] as Record<string, unknown>;
    expect(p.tool).toBe("ctx_search");
    expect(p.recoveredCount).toBe(2); // hits.length
    expect(p.conversationId).toBe("default:user_a:chan_a");
    for (const f of CONTENT_FIELDS) expect(p).not.toHaveProperty(f);
    expect(JSON.stringify(p)).not.toContain(rawSnippet);
  });

  it("ctx_inspect emits context:dag_expanded once with tool ctx_inspect, no summary content", async () => {
    const summary = makeSummary({ summaryId: "sum-parent", kind: "condensed", depth: 1 });
    const emit = vi.fn();
    const { store } = makeStore({
      getSummariesReturn: [summary],
      getSummaryChildrenReturn: [makeSummary({ summaryId: "child-a" })],
      getSummaryMessagesReturn: ["m1", "m2", "m3"],
    });
    const { deps } = makeDeps(store, { eventBus: { emit } });
    const tool = createCtxInspectTool(deps);
    await runExecute(tool, "emit-inspect", { summaryId: "sum-parent" }, liveCtx());

    const calls = emit.mock.calls.filter((c) => c[0] === "context:dag_expanded");
    expect(calls).toHaveLength(1);
    const p = calls[0]![1] as Record<string, unknown>;
    expect(p.tool).toBe("ctx_inspect");
    expect(typeof p.recoveredCount).toBe("number");
    expect(p.conversationId).toBe("default:user_a:chan_a");
    for (const f of CONTENT_FIELDS) expect(p).not.toHaveProperty(f);
    expect(JSON.stringify(p)).not.toContain(summary.content);
  });

  it("every ctx_* tool runs exactly as before when no eventBus is wired (optional, no throw, no emit)", async () => {
    // ctx_search
    const { store: s1 } = makeStore({
      searchLcdReturn: [{ kind: "message", refId: "m1", snippet: "hit", rank: -1 }],
    });
    const { deps: d1 } = makeDeps(s1); // no eventBus
    await expect(runExecute(createCtxSearchTool(d1), "nobus-search", { query: "x" }, liveCtx())).resolves.toBeDefined();

    // ctx_inspect
    const { store: s2 } = makeStore({
      getSummariesReturn: [makeSummary({ summaryId: "sum-1" })],
      getSummaryChildrenReturn: [],
      getSummaryMessagesReturn: ["m1"],
    });
    const { deps: d2 } = makeDeps(s2);
    await expect(runExecute(createCtxInspectTool(d2), "nobus-inspect", { summaryId: "sum-1" }, liveCtx())).resolves.toBeDefined();

    // ctx_expand
    const { store: s3 } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, "tiny body")],
    });
    const { deps: d3 } = makeDeps(s3);
    await expect(runExecute(createCtxExpandTool(d3), "nobus-expand", { summaryId: "sum-1" }, liveCtx())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// A throwing context:dag_expanded subscriber must NOT fail the recovery
// ---------------------------------------------------------------------------

describe("ctx_* tools: a throwing context:dag_expanded subscriber never fails the tool", () => {
  // TypedEventBus.emit delegates to Node's EventEmitter.emit, which propagates the
  // first subscriber exception synchronously back to the emitter. An unguarded emit
  // in the success path therefore converts a fully-completed recovery into a tool
  // error the model sees. The emit MUST be wrapped so observability can never fail
  // the recovery (mirroring the afterTurn emitters' non-fatal contract).
  const throwingBus = { emit: () => { throw new Error("subscriber boom (metrics sink down)"); } };

  it("ctx_search still returns its hits when the context:dag_expanded subscriber throws", async () => {
    const { store } = makeStore({
      searchLcdReturn: [{ kind: "message", refId: "m1", snippet: "recovered hit", rank: -1 }],
    });
    const { deps } = makeDeps(store, { eventBus: throwingBus });
    const tool = createCtxSearchTool(deps);
    const result = (await runExecute(tool, "throw-search", { query: "x" }, liveCtx())) as {
      details: { hits: Array<{ refId: string }> };
    };
    // The recovery succeeded despite the throwing subscriber — the result survives.
    expect(result.details.hits).toHaveLength(1);
    expect(result.details.hits[0].refId).toBe("m1");
  });

  it("ctx_inspect still returns its metadata when the context:dag_expanded subscriber throws", async () => {
    const { store } = makeStore({
      getSummariesReturn: [makeSummary({ summaryId: "sum-1" })],
      getSummaryChildrenReturn: [],
      getSummaryMessagesReturn: ["m1", "m2"],
    });
    const { deps } = makeDeps(store, { eventBus: throwingBus });
    const tool = createCtxInspectTool(deps);
    const result = (await runExecute(tool, "throw-inspect", { summaryId: "sum-1" }, liveCtx())) as {
      details: { summaryId: string };
    };
    expect(result.details.summaryId).toBe("sum-1");
  });

  it("ctx_expand (inline path) still returns its body when the context:dag_expanded subscriber throws", async () => {
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, "tiny recovered body")],
    });
    const { deps } = makeDeps(store, { eventBus: throwingBus });
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "throw-expand-inline", { summaryId: "sum-1" }, liveCtx())) as {
      details: { body?: string };
    };
    expect(result.details.body).toContain("tiny recovered body");
  });

  it("ctx_expand (spilled path) still returns its file handle when the context:dag_expanded subscriber throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-expand-throw-spill-"));
    try {
      const big = "Q".repeat(40_000);
      const { store } = makeStore({
        getSummaryMessagesReturn: ["m1"],
        getMessagesReturn: [makeMessage("m1", 1, big)],
      });
      const { deps } = makeDeps(store, { maxExpandTokens: 100, getToolResultsDir: () => dir, eventBus: throwingBus });
      const tool = createCtxExpandTool(deps);
      const result = (await runExecute(tool, "throw-expand-spill", { summaryId: "sum-1" }, liveCtx())) as {
        details: { fullOutputPath?: string };
      };
      expect(result.details.fullOutputPath).toBeDefined();
      expect(existsSync(result.details.fullOutputPath as string)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// durationMs and timestamp must be a SINGLE consistent clock snapshot
// ---------------------------------------------------------------------------

describe("ctx_* tools: the emit reads the end-instant ONCE so durationMs + timestamp agree", () => {
  // A monotonic stepping clock: each nowMs() read returns a strictly larger value.
  // t0 is the FIRST read in every ctx_* execute(). The emit reads the
  // end-instant ONCE (endMs) and reports durationMs = endMs - t0 with timestamp =
  // endMs — hence (timestamp - durationMs) === t0 === BASE. Reading the clock
  // TWICE (durationMs off one read, timestamp off a later read) would instead
  // give (timestamp - durationMs) === BASE + STEP, NOT BASE.
  const BASE = 5_000_000;
  const STEP = 1_000;

  function steppingClock(): () => number {
    let n = 0;
    return () => BASE + STEP * n++;
  }

  function emittedPayload(emit: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const calls = emit.mock.calls.filter((c) => c[0] === "context:dag_expanded");
    expect(calls).toHaveLength(1);
    return calls[0]![1] as Record<string, unknown>;
  }

  it("ctx_search: timestamp minus durationMs equals the single entry read (t0), not a later read", async () => {
    const emit = vi.fn();
    const { store } = makeStore({
      searchLcdReturn: [{ kind: "message", refId: "m1", snippet: "hit", rank: -1 }],
    });
    const { deps } = makeDeps(store, { eventBus: { emit }, nowMs: steppingClock() });
    await runExecute(createCtxSearchTool(deps), "wr03-search", { query: "x" }, liveCtx());
    const p = emittedPayload(emit);
    // The load-bearing invariant: durationMs and timestamp come from ONE read.
    expect((p.timestamp as number) - (p.durationMs as number)).toBe(BASE);
  });

  it("ctx_inspect: timestamp minus durationMs equals the single entry read (t0), not a later read", async () => {
    const emit = vi.fn();
    const { store } = makeStore({
      getSummariesReturn: [makeSummary({ summaryId: "sum-1" })],
      getSummaryChildrenReturn: [],
      getSummaryMessagesReturn: ["m1", "m2"],
    });
    const { deps } = makeDeps(store, { eventBus: { emit }, nowMs: steppingClock() });
    await runExecute(createCtxInspectTool(deps), "wr03-inspect", { summaryId: "sum-1" }, liveCtx());
    const p = emittedPayload(emit);
    expect((p.timestamp as number) - (p.durationMs as number)).toBe(BASE);
  });

  it("ctx_expand (inline path): timestamp minus durationMs equals the single entry read (t0)", async () => {
    const emit = vi.fn();
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, "tiny recovered body")],
    });
    const { deps } = makeDeps(store, { eventBus: { emit }, nowMs: steppingClock() });
    await runExecute(createCtxExpandTool(deps), "wr03-expand-inline", { summaryId: "sum-1" }, liveCtx());
    const p = emittedPayload(emit);
    expect((p.timestamp as number) - (p.durationMs as number)).toBe(BASE);
  });
});

// ---------------------------------------------------------------------------
// An oversized recovered body with NO tool-results dir must still be
//        bounded AND secret-scrubbed — never inlined raw/unbounded/unscrubbed.
// ---------------------------------------------------------------------------

describe("ctx_expand: an oversized body with no tool-results dir is bounded + scrubbed, not inlined raw", () => {
  // If the oversized-spill path were gated on a dir being present
  // (`if (oversized && dir)`), a context with no tool-results dir (heartbeat/
  // cron/ephemeral, or a parse failure) would fall through to the INLINE path
  // and return the FULL rawBody — unbounded AND skipping the
  // scrubSecretsFromText defense. That is an unbounded-inline + unscrubbed-egress
  // leak the cap exists to prevent.

  it("bounds an oversized no-dir body to the maxExpandTokens cap rather than inlining it whole", async () => {
    const maxExpandTokens = 100;
    // estimateTokens is chars/4, so the cap is maxExpandTokens * 4 chars.
    const capChars = maxExpandTokens * 4;
    const big = "X".repeat(40_000); // ~10_000 tokens >> the 100-token cap
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, big)],
    });
    // NO tool-results dir available (the degraded/ephemeral path).
    const { deps } = makeDeps(store, { maxExpandTokens, getToolResultsDir: () => undefined });
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "wr04-nodir-bound", { summaryId: "sum-1" }, liveCtx())) as {
      details: { body?: string; fullOutputPath?: string; truncated?: boolean };
    };
    // No file handle (no dir) — it is inlined, but the inlined body MUST be bounded.
    expect(result.details.fullOutputPath).toBeUndefined();
    expect(result.details.body).toBeDefined();
    // The whole 40_000-char raw body must NOT be inlined; the body is bounded by
    // the cap (plus the wrapExternalContent envelope overhead, which is small and
    // fixed).
    expect((result.details.body as string).length).toBeLessThan(capChars + 2_000);
    expect(result.details.truncated).toBe(true);
  });

  it("scrubs secrets from an oversized no-dir body before inlining it", async () => {
    const secret = "sk-ant-" + "A".repeat(64);
    // Put the secret at the very FRONT so truncation cannot be what removes it —
    // the scrub must be what redacts it.
    const big = secret + " " + "Y".repeat(40_000);
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, big)],
    });
    const { deps } = makeDeps(store, { maxExpandTokens: 100, getToolResultsDir: () => undefined });
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "wr04-nodir-scrub", { summaryId: "sum-1" }, liveCtx())) as {
      details: { body?: string };
    };
    // The secret must be redacted in the inlined body (the spill-branch scrub must
    // also run on the no-dir inline path).
    expect(result.details.body).toBeDefined();
    expect(result.details.body).not.toContain(secret);
    expect(result.details.body).toContain("[REDACTED]");
  });

  it("leaves a small no-dir body inlined verbatim (the bound + scrub apply only to the OVERSIZED no-dir case)", async () => {
    // Regression guard: the bound + scrub apply ONLY when oversized. A small body
    // with no dir must still inline verbatim (taint-wrapped).
    const small = "an ordinary small recovered body";
    const { store } = makeStore({
      getSummaryMessagesReturn: ["m1"],
      getMessagesReturn: [makeMessage("m1", 1, small)],
    });
    const { deps } = makeDeps(store, { maxExpandTokens: 4000, getToolResultsDir: () => undefined });
    const tool = createCtxExpandTool(deps);
    const result = (await runExecute(tool, "wr04-nodir-small", { summaryId: "sum-1" }, liveCtx())) as {
      details: { body?: string; truncated?: boolean };
    };
    expect(result.details.body).toContain(small);
    expect(result.details.body).toContain("UNTRUSTED");
    // Not truncated (it was never oversized).
    expect(result.details.truncated).toBeFalsy();
  });
});
