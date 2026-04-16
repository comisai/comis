import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ok, err } from "@comis/shared";
import type { MemoryReviewConfig } from "@comis/core";
import type { MemoryReviewDeps } from "./memory-review-job.js";

// Mock pi-ai
vi.mock("@mariozechner/pi-ai", () => ({
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
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { readFile, writeFile, rename } from "node:fs/promises";

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
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

function makeSession(key: string, messageCount: number, updatedAt: number = Date.now()) {
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

describe("runMemoryReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: watermark file does not exist
    (readFile as Mock).mockRejectedValue(new Error("ENOENT"));
    (writeFile as Mock).mockResolvedValue(undefined);
    (rename as Mock).mockResolvedValue(undefined);
  });

  it("skips sessions with messageCount below minMessages", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 3), // below 5
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
    const session = makeSession("agent:test-agent:default:user1:ch1", 10, 1000);
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([session]);
    // Watermark has this session at updatedAt 1000
    (readFile as Mock).mockResolvedValue(JSON.stringify({
      sessions: { "agent:test-agent:default:user1:ch1": 1000 },
    }));

    const result = await runMemoryReview(deps);
    expect(result.ok).toBe(true);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("calls completeSimple exactly once with all qualifying sessions batched", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
      makeSession("agent:test-agent:default:user2:ch1", 8, 3000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    });

    await runMemoryReview(deps);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("stores extracted preferences via memoryPort.store with correct fields", async () => {
    const deps = makeDeps({ config: makeConfig({ autoTags: ["custom-tag"] }) });
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "I prefer dark mode" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { content: "User prefers dark mode", session: "agent:test-agent:default:user1:ch1" },
      ]) }],
    });

    await runMemoryReview(deps);

    const storeCall = (deps.memoryPort.store as Mock).mock.calls[0]?.[0];
    expect(storeCall).toBeDefined();
    expect(storeCall.trustLevel).toBe("system");
    expect(storeCall.source).toEqual({ who: "system", channel: "memory-review" });
    expect(storeCall.tags).toContain("auto-review");
    expect(storeCall.tags).toContain("custom-tag");
    expect(storeCall.sourceType).toBe("conversation");
    expect(storeCall.content).toBe("User prefers dark mode");
  });

  it("skips storing when memoryPort.search finds existing match above dedupThreshold", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "I like dark mode" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { content: "User likes dark mode", session: "agent:test-agent:default:user1:ch1" },
      ]) }],
    });
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
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "I like tea" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { content: "User likes tea", session: "agent:test-agent:default:user1:ch1" },
      ]) }],
    });
    (deps.memoryPort.search as Mock).mockResolvedValue(ok([]));

    await runMemoryReview(deps);
    expect(deps.memoryPort.store).toHaveBeenCalledTimes(1);
  });

  it("updates watermark per-session after processing", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 5000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 5000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    });

    await runMemoryReview(deps);

    // Check that writeFile was called with .tmp path containing updated watermark
    expect(writeFile).toHaveBeenCalled();
    const writeCall = (writeFile as Mock).mock.calls[0];
    expect(writeCall[0]).toContain(".tmp");
    const watermarkData = JSON.parse(writeCall[1] as string);
    expect(watermarkData.sessions["agent:test-agent:default:user1:ch1"]).toBe(5000);

    // Check rename was called (atomic write)
    expect(rename).toHaveBeenCalled();
  });

  it("does NOT use executor.execute or PiExecutor -- only completeSimple", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    });

    await runMemoryReview(deps);
    // Verify completeSimple was called (not executor.execute)
    expect(completeSimple).toHaveBeenCalledTimes(1);
    // No executor.execute present on deps -- that's the contract
  });

  it("emits memory:review_completed event with correct metrics", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { content: "User says hello", session: "agent:test-agent:default:user1:ch1" },
      ]) }],
    });

    await runMemoryReview(deps);

    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      agentId: "test-agent",
      sessionsReviewed: 1,
      memoriesExtracted: 1,
      duplicatesSkipped: 0,
    }));
    // durationMs and timestamp should be present
    const payload = (deps.eventBus.emit as Mock).mock.calls[0]?.[1];
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(payload.timestamp).toBeGreaterThan(0);
  });

  it("handles LLM returning invalid JSON gracefully (returns ok with 0 memories)", async () => {
    const deps = makeDeps();
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: "This is not valid JSON at all" }],
    });

    const result = await runMemoryReview(deps);
    expect(result.ok).toBe(true);
    expect(deps.memoryPort.store).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("respects maxSessionsPerRun limit", async () => {
    const deps = makeDeps({ config: makeConfig({ maxSessionsPerRun: 1 }) });
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:test-agent:default:user1:ch1", 10, 2000),
      makeSession("agent:test-agent:default:user2:ch1", 10, 3000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    });

    await runMemoryReview(deps);
    // Only 1 session should be processed (sorted by updatedAt asc, so user1 first)
    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      sessionsReviewed: 1,
    }));
  });

  it("filters sessions by agentId prefix in session key", async () => {
    const deps = makeDeps({ agentId: "my-agent" });
    (deps.sessionStore.listDetailed as Mock).mockReturnValue([
      makeSession("agent:my-agent:default:user1:ch1", 10, 2000),
      makeSession("agent:other-agent:default:user1:ch1", 10, 3000),
    ]);
    (deps.sessionStore.loadByFormattedKey as Mock).mockReturnValue({
      messages: [{ role: "user", content: "hello" }],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    });
    (completeSimple as Mock).mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    });

    await runMemoryReview(deps);
    // Only my-agent session should be reviewed
    expect(deps.eventBus.emit).toHaveBeenCalledWith("memory:review_completed", expect.objectContaining({
      sessionsReviewed: 1,
    }));
  });
});
