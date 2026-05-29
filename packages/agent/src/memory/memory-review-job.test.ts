// SPDX-License-Identifier: Apache-2.0
//
// Structured-extraction suite for runMemoryReview (Phase 82 — EXTR-01..05).
//
// The flat-string `[{content, session}]` path was DELETED outright (design
// principle 8 — no dual mode, no fallback). Its assertions are GONE, not
// skipped. Every test now feeds the structured `{ "memories": [...] }`
// envelope the job parses via `parseExtractionResult` (Plan 02). A fixed
// injected `clock` makes relative-date resolution + createdAt deterministic
// (no wall-clock reads).
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ok } from "@comis/shared";
import { systemDateFrom, type MemoryReviewConfig } from "@comis/core";
import type { MemoryReviewDeps } from "./memory-review-job.js";

// Mock pi-ai
vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

import { runMemoryReview } from "./memory-review-job.js";
import { completeSimple } from "@earendil-works/pi-ai";
import { readFile, writeFile, rename } from "node:fs/promises";

/** Fixed reference clock — every time read in the job resolves to this. */
const NOW = 1_700_000_000_000;

function makeConfig(overrides: Partial<MemoryReviewConfig> = {}): MemoryReviewConfig {
  return {
    enabled: true,
    schedule: "0 2 * * *",
    minMessages: 5,
    maxSessionsPerRun: 10,
    maxReviewTokens: 4096,
    dedupThreshold: 0.85,
    autoTags: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MemoryReviewDeps> = {}): MemoryReviewDeps {
  return {
    agentId: "test-agent",
    tenantId: "default",
    agentName: "TestBot",
    config: makeConfig(),
    memoryPort: {
      store: vi.fn().mockResolvedValue(ok({ id: "mem-1" })),
      search: vi.fn().mockResolvedValue(ok([])),
    } as unknown as MemoryReviewDeps["memoryPort"],
    sessionStore: {
      listDetailed: vi.fn().mockReturnValue([]),
      loadByFormattedKey: vi.fn().mockReturnValue(undefined),
    },
    eventBus: {
      emit: vi.fn(),
    },
    workspacePath: "/tmp/test-workspace",
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "test-key",
    // Fixed injected clock — proves clock injection (never Date.now) and makes
    // relative-date resolution deterministic.
    clock: { now: () => NOW, nowDate: () => systemDateFrom(NOW) },
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

function makeSession(key: string, messageCount: number, updatedAt: number = NOW) {
  return {
    sessionKey: key,
    tenantId: "default",
    userId: "user1",
    channelId: "ch1",
    metadata: null,
    createdAt: updatedAt - 10000,
    updatedAt,
    messageCount,
  };
}

/** Wrap a structured extraction payload as a completeSimple text response. */
function structuredResponse(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Wrap raw LLM text verbatim (used to assert the exact `{"memories":[...]}` envelope). */
function rawResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

/** A single qualifying session + a loaded message body (the common arrange). */
function arrangeOneSession(deps: MemoryReviewDeps, updatedAt = 2000, content = "hello") {
  (deps.sessionStore.listDetailed as Mock).mockReturnValue([
    makeSession("default:user1:ch1", 10, updatedAt),
  ]);
  (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
    messages: [{ role: "user", content }],
    metadata: {},
    createdAt: 1000,
    updatedAt,
  });
}

describe("runMemoryReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: watermark file does not exist
    (readFile as Mock).mockRejectedValue(new Error("ENOENT"));
    (writeFile as Mock).mockResolvedValue(undefined);
    (rename as Mock).mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Filtering / batching / lifecycle (still valid — fed STRUCTURED output)
  // -------------------------------------------------------------------------

  it("skips sessions with messageCount below minMessages", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("default:user1:ch1", 3), // below 5
    ]);

    const result = await runMemoryReview(deps);
    expect(result.ok).toBe(true);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      sessionsReviewed: 0,
      memoriesExtracted: 0,
    }));
  });

  it("skips sessions whose updatedAt is before watermark", async () => {
    const deps = makeDeps();
    const session = makeSession("default:user1:ch1", 10, 1000);
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([session]);
    // Watermark has this session at updatedAt 1000
    (readFile as Mock).mockResolvedValue(JSON.stringify({
      sessions: { "default:user1:ch1": 1000 },
    }));

    const result = await runMemoryReview(deps);
    expect(result.ok).toBe(true);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("calls completeSimple exactly once with all qualifying sessions batched", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("default:user1:ch1", 10, 2000),
      makeSession("default:user2:ch1", 8, 3000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue(structuredResponse({ memories: [] }));

    await runMemoryReview(deps);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("respects maxSessionsPerRun limit", async () => {
    const deps = makeDeps({ config: makeConfig({ maxSessionsPerRun: 1 }) });
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("default:user1:ch1", 10, 2000),
      makeSession("default:user2:ch1", 10, 3000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue(structuredResponse({ memories: [] }));

    await runMemoryReview(deps);
    // Only 1 session should be processed (sorted by updatedAt asc, so user1 first)
    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      sessionsReviewed: 1,
    }));
  });

  it("reviews all sessions in the tenant (no agent-prefix filter)", async () => {
    const deps = makeDeps({ agentId: "my-agent" });
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      // Both sessions are in the same tenant; no agent prefix in either key.
      makeSession("default:user1:ch1", 10, 2000),
      makeSession("default:user2:ch1", 10, 3000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue(structuredResponse({ memories: [] }));

    await runMemoryReview(deps);
    // Both tenant sessions reviewed (no per-agent prefix filter).
    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      sessionsReviewed: 2,
    }));
  });

  it("does NOT use executor.execute or PiExecutor -- only completeSimple", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps);
    (completeSimple as Mock).mockResolvedValue(structuredResponse({ memories: [] }));

    await runMemoryReview(deps);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    // No executor.execute present on deps -- that's the contract
  });

  // -------------------------------------------------------------------------
  // EXTR-01 / EXTR-02 — structured store of content + resolved occurredAt
  // -------------------------------------------------------------------------

  it("stores a structured memory's content + resolved occurredAt", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps);
    (completeSimple as Mock).mockResolvedValue(rawResponse(
      '{"memories":[{"content":"User lives in Berlin",' +
        '"occurredAt":"2023-11-10T00:00:00Z","entities":[{"name":"user"},{"name":"Berlin"}]}]}',
    ));

    await runMemoryReview(deps);

    const storeCall = (deps.memoryPort.store as Mock).mock.calls[0]?.[0];
    expect(storeCall).toBeDefined();
    expect(storeCall.content).toBe("User lives in Berlin");
    // occurredAt resolved to a finite epoch ms (against the fixed NOW reference).
    expect(storeCall.occurredAt).toBe(Date.parse("2023-11-10T00:00:00Z"));
    expect(Number.isFinite(storeCall.occurredAt)).toBe(true);
  });

  it("omits occurredAt when the LLM emits none", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps);
    (completeSimple as Mock).mockResolvedValue(structuredResponse({
      memories: [{ content: "User enjoys hiking", entities: [{ name: "user" }] }],
    }));

    await runMemoryReview(deps);

    const storeCall = (deps.memoryPort.store as Mock).mock.calls[0]?.[0];
    expect(storeCall).toBeDefined();
    expect(storeCall.content).toBe("User enjoys hiking");
    expect(storeCall.occurredAt).toBeUndefined();
    expect("occurredAt" in storeCall).toBe(false);
  });

  // -------------------------------------------------------------------------
  // EXTR-04 — trust + provenance inheritance (one consistent system trust)
  // -------------------------------------------------------------------------

  it("inherits trust + provenance consistently", async () => {
    const deps = makeDeps({ config: makeConfig({ autoTags: ["custom-tag"] }) });
    arrangeOneSession(deps);
    (completeSimple as Mock).mockResolvedValue(rawResponse(
      '{"memories":[{"content":"User prefers dark mode","entities":[{"name":"user"}]}]}',
    ));

    await runMemoryReview(deps);

    const storeCall = (deps.memoryPort.store as Mock).mock.calls[0]?.[0];
    expect(storeCall).toBeDefined();
    expect(storeCall.trustLevel).toBe("system");
    expect(storeCall.source).toEqual({ who: "system", channel: "memory-review" });
    expect(storeCall.tags).toContain("auto-review");
    expect(storeCall.tags).toContain("custom-tag");
    expect(storeCall.sourceType).toBe("conversation");
  });

  it("uses the injected clock, never Date.now", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps);
    (completeSimple as Mock).mockResolvedValue(structuredResponse({
      memories: [{ content: "User says hello", entities: [{ name: "user" }] }],
    }));

    await runMemoryReview(deps);

    const storeCall = (deps.memoryPort.store as Mock).mock.calls[0]?.[0];
    expect(storeCall).toBeDefined();
    // createdAt is read from the injected clock (NOW), not the wall clock.
    expect(storeCall.createdAt).toBe(NOW);
  });

  // -------------------------------------------------------------------------
  // Dedup (reused) — fed structured output
  // -------------------------------------------------------------------------

  it("skips storing when memoryPort.search finds existing match above dedupThreshold", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps, 2000, "I like dark mode");
    (completeSimple as Mock).mockResolvedValue(structuredResponse({
      memories: [{ content: "User likes dark mode", entities: [{ name: "user" }] }],
    }));
    // Search returns a match (above dedupThreshold)
    (deps.memoryPort.search as Mock).mockResolvedValue(ok([{
      entry: { id: "existing", content: "User prefers dark mode" },
      score: 0.90,
    }]));

    await runMemoryReview(deps);
    expect(deps.memoryPort.store).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      duplicatesSkipped: 1,
      memoriesExtracted: 0,
    }));
  });

  it("stores when memoryPort.search returns no matches", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps, 2000, "I like tea");
    (completeSimple as Mock).mockResolvedValue(structuredResponse({
      memories: [{ content: "User likes tea", entities: [{ name: "user" }] }],
    }));
    (deps.memoryPort.search as Mock).mockResolvedValue(ok([]));

    await runMemoryReview(deps);
    expect(deps.memoryPort.store).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Watermark (reused) — fed structured output
  // -------------------------------------------------------------------------

  it("updates watermark per-session after processing", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps, 5000);
    (completeSimple as Mock).mockResolvedValue(structuredResponse({ memories: [] }));

    await runMemoryReview(deps);

    // Check that writeFile was called with .tmp path containing updated watermark
    expect(writeFile).toHaveBeenCalled();
    const writeCall = (writeFile as Mock).mock.calls[0];
    expect(writeCall[0]).toContain(".tmp");
    const watermarkData = JSON.parse(writeCall[1] as string);
    expect(watermarkData.sessions["default:user1:ch1"]).toBe(5000);

    // Check rename was called (atomic write)
    expect(rename).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Event metrics (reused) — fed structured output
  // -------------------------------------------------------------------------

  it("emits memory:review_completed event with correct metrics", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps);
    (completeSimple as Mock).mockResolvedValue(structuredResponse({
      memories: [{ content: "User says hello", entities: [{ name: "user" }] }],
    }));

    await runMemoryReview(deps);

    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      agentId: "test-agent",
      sessionsReviewed: 1,
      memoriesExtracted: 1,
      duplicatesSkipped: 0,
    }));
    const payload = (deps.eventBus.emit as Mock).mock.calls[0]?.[1];
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(payload.timestamp).toBe(NOW);
  });

  // -------------------------------------------------------------------------
  // EXTR-01 / EXTR-05 — no flat-string fallback (principle 8)
  // -------------------------------------------------------------------------

  it("rejects the OLD flat array shape as malformed (no fallback)", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps, 4242);
    // The DELETED flat shape — must NOT be parsed; there is no fallback path.
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([{ content: "x", session: "s" }]) }],
    });

    const result = await runMemoryReview(deps);
    expect(result.ok).toBe(true);
    expect(deps.memoryPort.store).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: expect.anything(), hint: expect.anything() }),
      expect.any(String),
    );
    // Watermark STILL advances (no stall) — principle-8 no-fallback + EXTR-05.
    expect(writeFile).toHaveBeenCalled();
    const writeCall = (writeFile as Mock).mock.calls[0];
    const watermarkData = JSON.parse(writeCall[1] as string);
    expect(watermarkData.sessions["default:user1:ch1"]).toBe(4242);
    expect(rename).toHaveBeenCalled();
  });

  it("malformed output is non-fatal AND advances the watermark", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps, 7777);
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: "not json at all" }],
    });

    const result = await runMemoryReview(deps);
    expect(result.ok).toBe(true);
    expect(deps.memoryPort.store).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: expect.anything(), hint: expect.anything() }),
      expect.any(String),
    );
    // Watermark advanced to the reviewed session's updatedAt (Pitfall 4 regression).
    expect(writeFile).toHaveBeenCalled();
    const writeCall = (writeFile as Mock).mock.calls[0];
    expect(writeCall[0]).toContain(".tmp");
    const watermarkData = JSON.parse(writeCall[1] as string);
    expect(watermarkData.sessions["default:user1:ch1"]).toBe(7777);
    expect(rename).toHaveBeenCalled();
  });

  it("a single invalid memory is skipped but valid siblings still store", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps, 8888);
    // One invalid (empty content fails content.min(1)) + one valid memory.
    (completeSimple as Mock).mockResolvedValue(structuredResponse({
      memories: [
        { content: "", entities: [] },
        { content: "User likes coffee", entities: [{ name: "user" }] },
      ],
    }));

    const result = await runMemoryReview(deps);
    expect(result.ok).toBe(true);
    // The watermark MUST advance and the run MUST be ok regardless of whether
    // the implementation does per-item skip or whole-batch skip.
    expect(writeFile).toHaveBeenCalled();
    const writeCall = (writeFile as Mock).mock.calls[0];
    const watermarkData = JSON.parse(writeCall[1] as string);
    expect(watermarkData.sessions["default:user1:ch1"]).toBe(8888);
    // No invalid item is ever stored.
    const storedContents = (deps.memoryPort.store as Mock).mock.calls.map((c) => c[0].content);
    expect(storedContents).not.toContain("");
  });

  // -------------------------------------------------------------------------
  // EXTR-04 / Q4b — entities emitted, NOT persisted
  // -------------------------------------------------------------------------

  it("emits entities on the result without persisting them", async () => {
    const deps = makeDeps();
    arrangeOneSession(deps);
    (completeSimple as Mock).mockResolvedValue(rawResponse(
      '{"memories":[{"content":"User works at Acme","entities":[{"name":"user"},{"name":"Acme"}]}]}',
    ));

    await runMemoryReview(deps);

    // The stored entry carries NO entities field — entities are emit-only (Q4b).
    const storeCall = (deps.memoryPort.store as Mock).mock.calls[0]?.[0];
    expect(storeCall).toBeDefined();
    expect(storeCall.entities).toBeUndefined();
    expect("entities" in storeCall).toBe(false);
  });
});
