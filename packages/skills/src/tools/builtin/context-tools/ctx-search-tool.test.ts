// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_search` script-health signal wiring tests.
 *
 * The tool consumes the widened `LcdSearchResult`
 * (`scriptZeroHit`/`lane`/`matchErrored`/`scanCapped`) and:
 *   - emits `context:script_zero_hit { conversationId, agentId, sessionKey,
 *     scriptClass, lane, timestamp }` on a CLEAN non-Latin zero-hit, instead of
 *     a `cjkZeroHit` DEBUG line;
 *   - NEVER emits when `matchErrored` is true (a `safeAll`-swallowed FTS5 error
 *     stays a content-free WARN with `hint` + `errorKind`, §2.7 — signal purity);
 *   - surfaces the scan cap to the model when `lane === "scan" && scanCapped`;
 *   - surfaces `lane` in the result JSON;
 *   - swallows a throwing emit subscriber (guarded-emit — never fails the tool).
 *
 * Pure-JS / macOS-green: a hand-built `ContextToolDeps` with a stub
 * `ContextStorePort.searchLcd` returning a widened `LcdSearchResult`, a recording
 * `ToolLogger`, a capturing structural `eventBus`, and a fixed `nowMs`.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

import {
  runWithContext,
  type RequestContext,
  type ContextStorePort,
  type ContextStoreScope,
  type LcdSearchHit,
  type LcdSearchResult,
} from "@comis/core";

import { createCtxSearchTool, type ContextToolDeps } from "./index.js";

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

/** A capturing structural event bus (skills sees `{ emit(event, data) }` ONLY). */
function makeCapturingBus(): {
  emits: Array<{ event: string; data: unknown }>;
  emit: (event: string, data: unknown) => void;
} {
  const emits: Array<{ event: string; data: unknown }> = [];
  return { emits, emit: (event, data) => emits.push({ event, data }) };
}

/** A throwing event bus (a trajectory writer / metrics sink that blows up). */
function makeThrowingBus(): { emit: (event: string, data: unknown) => void } {
  return {
    emit: () => {
      throw new Error("subscriber boom");
    },
  };
}

/** A neutral RequestContext with a live, fully-scoped session. */
function liveCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "default",
    userId: "user_a",
    sessionKey: "default:user_a:chan_a",
    agentId: "agent_a",
    traceId: randomUUID(),
    startedAt: 1_000_000,
    trustLevel: "user",
    contentDelimiter: "test-delimiter-0123456789",
    ...overrides,
  };
}

/**
 * Build a stub store whose `searchLcd` returns the supplied widened result. Only
 * `searchLcd` is implemented (the only method ctx_search calls).
 */
function makeStore(result: LcdSearchResult): ContextStorePort {
  return {
    searchLcd(_scope: ContextStoreScope, _query: string, _opts: unknown): LcdSearchResult {
      return result;
    },
  } as unknown as ContextStorePort;
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

async function runExecute(
  tool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> },
  params: Record<string, unknown>,
  ctx: RequestContext,
): Promise<unknown> {
  return runWithContext(ctx, () => tool.execute("call-1", params));
}

const HIT: LcdSearchHit = { kind: "message", refId: "m1", snippet: "a hit", rank: -1 };

// ---------------------------------------------------------------------------
// context:script_zero_hit emit (purity-gated)
// ---------------------------------------------------------------------------

describe("ctx_search — context:script_zero_hit emit", () => {
  it("emits exactly one content-free context:script_zero_hit on a clean non-Latin zero-hit", async () => {
    const bus = makeCapturingBus();
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: false,
      scriptZeroHit: "hebrew",
      lane: "tri",
      matchErrored: false,
    };
    const { deps } = makeDeps(makeStore(result), { eventBus: bus });
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: "anything" }, liveCtx());

    const zeroHits = bus.emits.filter((e) => e.event === "context:script_zero_hit");
    expect(zeroHits).toHaveLength(1);
    const payload = zeroHits[0]!.data as Record<string, unknown>;
    // Exact contract (events-messaging.ts): ids + closed enums + lane + timestamp.
    expect(payload.conversationId).toBe("default:user_a:chan_a");
    expect(payload.agentId).toBe("agent_a");
    expect(payload.sessionKey).toBe("default:user_a:chan_a");
    expect(payload.scriptClass).toBe("hebrew");
    expect(payload.lane).toBe("tri");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.timestamp).toBe(1_700_000_000_000);
    // Content-free: the payload carries NO query text and NO extra fields.
    expect(Object.keys(payload).sort()).toEqual(
      ["agentId", "conversationId", "lane", "scriptClass", "sessionKey", "timestamp"].sort(),
    );
  });

  it("forwards the scan lane on a clean non-Latin zero-hit that fell to the scan floor", async () => {
    const bus = makeCapturingBus();
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: false,
      scriptZeroHit: "arabic",
      lane: "scan",
      matchErrored: false,
    };
    const { deps } = makeDeps(makeStore(result), { eventBus: bus });
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: "x" }, liveCtx());

    const zeroHits = bus.emits.filter((e) => e.event === "context:script_zero_hit");
    expect(zeroHits).toHaveLength(1);
    const payload = zeroHits[0]!.data as Record<string, unknown>;
    expect(payload.scriptClass).toBe("arabic");
    expect(payload.lane).toBe("scan");
  });

  it("does NOT emit context:script_zero_hit when the search returned hits", async () => {
    const bus = makeCapturingBus();
    const result: LcdSearchResult = {
      hits: [HIT],
      cjkZeroHit: false,
      lane: "tri",
      matchErrored: false,
    };
    const { deps, logger } = makeDeps(makeStore(result), { eventBus: bus });
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: "x" }, liveCtx());

    expect(bus.emits.filter((e) => e.event === "context:script_zero_hit")).toHaveLength(0);
    expect(logger.logs.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  it("does NOT emit when scriptZeroHit is absent (a Latin/neutral zero-hit)", async () => {
    const bus = makeCapturingBus();
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: false,
      lane: "word",
      matchErrored: false,
    };
    const { deps } = makeDeps(makeStore(result), { eventBus: bus });
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: "docker" }, liveCtx());

    expect(bus.emits.filter((e) => e.event === "context:script_zero_hit")).toHaveLength(0);
  });

  it("never leaks the query text into the script_zero_hit payload", async () => {
    const bus = makeCapturingBus();
    const rawQuery = "supercalifragilistic-unique-token";
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: false,
      scriptZeroHit: "cjk",
      lane: "tri",
      matchErrored: false,
    };
    const { deps } = makeDeps(makeStore(result), { eventBus: bus });
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: rawQuery }, liveCtx());

    const blob = JSON.stringify(bus.emits);
    expect(blob).not.toContain(rawQuery);
  });

  it("still returns its result when the script_zero_hit subscriber throws (guarded emit)", async () => {
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: false,
      scriptZeroHit: "hebrew",
      lane: "tri",
      matchErrored: false,
    };
    const { deps, logger } = makeDeps(makeStore(result), { eventBus: makeThrowingBus() });
    const tool = createCtxSearchTool(deps);

    // The throw must NOT unwind out of execute() — the tool returns its (empty) result.
    const out = (await runExecute(tool, { query: "x" }, liveCtx())) as {
      details: { hits: unknown[] };
    };
    expect(out.details.hits).toEqual([]);
    // The swallowed-subscriber WARN is content-free with hint + errorKind.
    const warns = logger.logs.filter((l) => l.level === "warn");
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.some((w) => w.obj.errorKind === "dependency" && typeof w.obj.hint === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchErrored — signal purity: WARN, never an emit
// ---------------------------------------------------------------------------

describe("ctx_search — matchErrored signal purity", () => {
  it("does NOT emit context:script_zero_hit when matchErrored is true; WARNs with hint + errorKind", async () => {
    const bus = makeCapturingBus();
    // A swallowed FTS5 syntax error: matchErrored true, no scriptZeroHit.
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: false,
      lane: "tri",
      matchErrored: true,
    };
    const { deps, logger } = makeDeps(makeStore(result), { eventBus: bus });
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: "x" }, liveCtx());

    // Signal purity: the error path NEVER counts as a lane gap.
    expect(bus.emits.filter((e) => e.event === "context:script_zero_hit")).toHaveLength(0);
    // Instead the tool WARNs (§2.7): hint naming the FTS MATCH failure + errorKind.
    const warns = logger.logs.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    const w = warns[0]!;
    expect(w.obj.errorKind).toBeDefined();
    expect(typeof w.obj.hint).toBe("string");
    expect(w.obj.lane).toBe("tri");
    expect(w.obj.step).toBe("lcd-search");
  });

  it("never leaks the query text into the matchErrored WARN payload", async () => {
    const rawQuery = "uniquely-identifiable-errored-token";
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: false,
      lane: "tri",
      matchErrored: true,
    };
    const { deps, logger } = makeDeps(makeStore(result));
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: rawQuery }, liveCtx());

    const blob = flattenLoggedValues(logger.logs);
    expect(blob).not.toContain(rawQuery);
  });
});

// ---------------------------------------------------------------------------
// scan-cap surfacing + lane in the result JSON
// ---------------------------------------------------------------------------

describe("ctx_search — scan-cap surfacing + lane in the result", () => {
  it("appends the cap note to the result when lane === scan && scanCapped", async () => {
    const result: LcdSearchResult = {
      hits: [HIT],
      cjkZeroHit: false,
      lane: "scan",
      matchErrored: false,
      scanCapped: true,
    };
    const { deps } = makeDeps(makeStore(result));
    const tool = createCtxSearchTool(deps);

    const out = (await runExecute(tool, { query: "x" }, liveCtx())) as {
      details: { lane: string; scanCapped?: boolean; capNote?: string };
    };
    expect(out.details.lane).toBe("scan");
    // The pinned cap wording surfaced to the model (the "cap noted in result" criterion).
    const blob = JSON.stringify(out.details);
    expect(blob).toContain("2,000 most recent");
    expect(out.details.scanCapped).toBe(true);
  });

  it("does NOT append a cap note when the scan was not capped", async () => {
    const result: LcdSearchResult = {
      hits: [HIT],
      cjkZeroHit: false,
      lane: "scan",
      matchErrored: false,
      scanCapped: false,
    };
    const { deps } = makeDeps(makeStore(result));
    const tool = createCtxSearchTool(deps);

    const out = (await runExecute(tool, { query: "x" }, liveCtx())) as {
      details: Record<string, unknown>;
    };
    expect(out.details.lane).toBe("scan");
    expect(JSON.stringify(out.details)).not.toContain("2,000 most recent");
  });

  it("does NOT append a cap note for the tri lane even if scanCapped were somehow set", async () => {
    const result: LcdSearchResult = {
      hits: [HIT],
      cjkZeroHit: false,
      lane: "tri",
      matchErrored: false,
      scanCapped: true,
    };
    const { deps } = makeDeps(makeStore(result));
    const tool = createCtxSearchTool(deps);

    const out = (await runExecute(tool, { query: "x" }, liveCtx())) as {
      details: { lane: string };
    };
    expect(out.details.lane).toBe("tri");
    expect(JSON.stringify(out.details)).not.toContain("2,000 most recent");
  });

  it("surfaces the word lane in the result for an all-Latin query", async () => {
    const result: LcdSearchResult = {
      hits: [HIT],
      cjkZeroHit: false,
      lane: "word",
      matchErrored: false,
    };
    const { deps } = makeDeps(makeStore(result));
    const tool = createCtxSearchTool(deps);

    const out = (await runExecute(tool, { query: "docker" }, liveCtx())) as {
      details: { lane: string };
    };
    expect(out.details.lane).toBe("word");
  });
});

// ---------------------------------------------------------------------------
// No DEBUG-only cjkZeroHit line is emitted
// ---------------------------------------------------------------------------

describe("ctx_search — emits no cjkZeroHit DEBUG line for a CJK zero-hit", () => {
  it("does not emit a DEBUG 'lcd FTS returned zero hits for CJK query' line", async () => {
    const result: LcdSearchResult = {
      hits: [],
      cjkZeroHit: true, // the derived boolean is no longer consumed by the tool
      scriptZeroHit: "cjk",
      lane: "tri",
      matchErrored: false,
    };
    const { deps, logger } = makeDeps(makeStore(result), { eventBus: makeCapturingBus() });
    const tool = createCtxSearchTool(deps);

    await runExecute(tool, { query: "x" }, liveCtx());

    const cjkDebug = logger.logs.filter(
      (l) => l.level === "debug" && l.msg.includes("zero hits for CJK"),
    );
    expect(cjkDebug).toHaveLength(0);
  });
});
