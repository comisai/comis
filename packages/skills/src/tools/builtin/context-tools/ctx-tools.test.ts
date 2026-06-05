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
 * NOT the RPC `session_search`/`memory_search` recall path — there is ZERO
 * `rpcCall`/`memory.*`/`@comis/memory` code path here (the E2/I2 boundary).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  runWithContext,
  type RequestContext,
  type ContextStorePort,
  type LcdSummary,
  type LcdMessage,
  type LcdSearchHit,
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

/** A neutral RequestContext with a live session (AGENTS.md §2.2 neutral fixtures). */
function liveCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "default",
    userId: "user_a",
    sessionKey: "default:user_a:chan_a",
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
  searchLcdArgs: Array<{ conversationId: string; query: string; opts: unknown }>;
  searchLcdReturn: LcdSearchHit[];
  getSummariesReturn: LcdSummary[];
  getSummaryChildrenReturn: LcdSummary[];
  getSummaryMessagesReturn: string[];
  getMessagesReturn: LcdMessage[];
}

function makeStore(over: Partial<StoreStub> = {}): { stub: StoreStub; store: ContextStorePort } {
  const stub: StoreStub = {
    searchLcdArgs: [],
    searchLcdReturn: [],
    getSummariesReturn: [],
    getSummaryChildrenReturn: [],
    getSummaryMessagesReturn: [],
    getMessagesReturn: [],
    ...over,
  };
  const store = {
    searchLcd(conversationId: string, query: string, opts: unknown): LcdSearchHit[] {
      stub.searchLcdArgs.push({ conversationId, query, opts });
      return stub.searchLcdReturn;
    },
    getSummaries(_conversationId: string): LcdSummary[] {
      return stub.getSummariesReturn;
    },
    getSummaryChildren(_conversationId: string, _parentSummaryId: string): LcdSummary[] {
      return stub.getSummaryChildrenReturn;
    },
    getSummaryMessages(_conversationId: string, _summaryId: string): string[] {
      return stub.getSummaryMessagesReturn;
    },
    getMessages(_conversationId: string): LcdMessage[] {
      return stub.getMessagesReturn;
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
    const raw = 'release "v2.12" AND (lossless OR dag)';
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
    expect(stub.searchLcdArgs[0].conversationId).toBe("default:user_a:chan_a");
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
});
