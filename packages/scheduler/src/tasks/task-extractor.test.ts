// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractionFn, TaskExtractorDeps } from "./task-extractor.js";
import type { TaskStore } from "./task-store.js";
import type { ExtractedTask } from "./task-types.js";
import { createTaskExtractor } from "./task-extractor.js";

const FIXED_NOW = Date.parse("2026-02-08T12:00:00Z");
const FIXED_ID = "test-uuid-001";
let idCounter = 0;

function makeId(): string {
  idCounter += 1;
  return `test-uuid-${String(idCounter).padStart(3, "0")}`;
}

function makeMockStore(): TaskStore & { tasks: ExtractedTask[] } {
  const tasks: ExtractedTask[] = [];
  return {
    tasks,
    load: vi.fn(async () => [...tasks]),
    save: vi.fn(async (t: ExtractedTask[]) => {
      tasks.length = 0;
      tasks.push(...t);
    }),
    addTask: vi.fn(async (t: ExtractedTask) => {
      tasks.push(t);
    }),
    updateTask: vi.fn(async () => true),
    removeTask: vi.fn(async () => true),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    getByStatus: vi.fn(async (status: string) => tasks.filter((t) => t.status === status)),
  };
}

function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeDeps(overrides?: Partial<TaskExtractorDeps>): TaskExtractorDeps {
  const defaultExtractFn: ExtractionFn = async () => ({
    tasks: [
      {
        title: "Deploy v2",
        description: "Deploy version 2 to production",
        priority: "high" as const,
        confidence: 0.95,
      },
    ],
    reasoning: "User committed to deploying v2",
  });

  return {
    extractFn: defaultExtractFn,
    store: makeMockStore(),
    logger: makeMockLogger(),
    config: { enabled: true, confidenceThreshold: 0.7 },
    eventBus: new TypedEventBus(),
    generateId: makeId,
    nowMs: () => FIXED_NOW,
    ...overrides,
  };
}

describe("TaskExtractor", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it("extract returns empty array when disabled", async () => {
    const extractFn = vi.fn<ExtractionFn>(async () => ({ tasks: [] }));
    const deps = makeDeps({
      extractFn,
      config: { enabled: false, confidenceThreshold: 0.7 },
    });
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("some conversation", "tg:default:peer:user1");

    expect(result).toEqual([]);
    expect(extractFn).not.toHaveBeenCalled();
  });

  it("extract calls extractFn with conversation text and session key", async () => {
    const extractFn = vi.fn<ExtractionFn>(async () => ({ tasks: [], reasoning: "none" }));
    const deps = makeDeps({ extractFn });
    const extractor = createTaskExtractor(deps);

    await extractor.extract("hello world", "tg:default:peer:user42");

    expect(extractFn).toHaveBeenCalledWith("hello world", "tg:default:peer:user42");
  });

  it("extract validates result through Zod schema", async () => {
    const deps = makeDeps();
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("deploy conversation", "tg:default:peer:user1");

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Deploy v2");
    expect(result[0].priority).toBe("high");
  });

  it("extract filters tasks below confidence threshold", async () => {
    const extractFn: ExtractionFn = async () => ({
      tasks: [
        { title: "High confidence", priority: "high", confidence: 0.95 },
        { title: "Low confidence", priority: "low", confidence: 0.3 },
        { title: "At threshold", priority: "medium", confidence: 0.7 },
      ],
    });
    const deps = makeDeps({ extractFn, config: { enabled: true, confidenceThreshold: 0.7 } });
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("text", "tg:default:peer:user1");

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.title)).toEqual(["High confidence", "At threshold"]);
  });

  it("extract assigns ID, createdAtMs, status, and source fields", async () => {
    const deps = makeDeps();
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("deploy convo", "tg:default:peer:user1");

    expect(result).toHaveLength(1);
    const task = result[0];
    expect(task.id).toBe("test-uuid-001");
    expect(task.createdAtMs).toBe(FIXED_NOW);
    expect(task.status).toBe("pending");
    expect(task.source.sessionKey).toBe("tg:default:peer:user1");
    expect(task.source.extractedAt).toBe(FIXED_NOW);
    expect(task.source.messageIndex).toBe(0);
  });

  it("extract saves tasks to store", async () => {
    const store = makeMockStore();
    const deps = makeDeps({ store });
    const extractor = createTaskExtractor(deps);

    await extractor.extract("deploy convo", "tg:default:peer:user1");

    expect(store.addTask).toHaveBeenCalledTimes(1);
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0].title).toBe("Deploy v2");
  });

  it("extract emits scheduler:task_extracted event for each task", async () => {
    const eventBus = new TypedEventBus();
    const events: unknown[] = [];
    eventBus.on("scheduler:task_extracted", (payload) => events.push(payload));

    const deps = makeDeps({ eventBus });
    const extractor = createTaskExtractor(deps);

    await extractor.extract("deploy convo", "tg:default:peer:user1");

    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.taskId).toBe("test-uuid-001");
    expect(event.title).toBe("Deploy v2");
    expect(event.priority).toBe("high");
    expect(event.confidence).toBe(0.95);
    expect(event.sessionKey).toBe("tg:default:peer:user1");
    expect(event.timestamp).toBe(FIXED_NOW);
  });

  it("extract returns empty array when extractFn returns invalid data", async () => {
    const extractFn = vi.fn(async () => ({
      tasks: [
        // Missing required 'priority' field
        { title: "Bad task", confidence: 0.9 } as never,
      ],
    }));
    const logger = makeMockLogger();
    const deps = makeDeps({ extractFn, logger });
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("text", "tg:default:peer:user1");

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("extract returns empty array when extractFn returns empty tasks array", async () => {
    const extractFn: ExtractionFn = async () => ({ tasks: [], reasoning: "No tasks found" });
    const deps = makeDeps({ extractFn });
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("casual chat", "tg:default:peer:user1");

    expect(result).toEqual([]);
  });

  it("high confidence tasks pass through, low confidence filtered out (threshold=0.8)", async () => {
    const extractFn: ExtractionFn = async () => ({
      tasks: [
        { title: "Definite task", priority: "high", confidence: 0.9 },
        { title: "Maybe task", priority: "low", confidence: 0.6 },
        { title: "Uncertain task", priority: "medium", confidence: 0.79 },
      ],
    });
    const deps = makeDeps({ extractFn, config: { enabled: true, confidenceThreshold: 0.8 } });
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("text", "tg:default:peer:user1");

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Definite task");
  });

  it("getExtractionPrompt returns a non-empty string containing JSON format instructions", () => {
    const deps = makeDeps();
    const extractor = createTaskExtractor(deps);

    const prompt = extractor.getExtractionPrompt();

    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("tasks");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("priority");
    expect(prompt).toContain("critical");
    expect(prompt).toContain("hallucinate");
  });

  it("multiple tasks from single extraction are all saved and returned", async () => {
    const extractFn: ExtractionFn = async () => ({
      tasks: [
        { title: "Task A", priority: "critical", confidence: 0.95 },
        { title: "Task B", priority: "high", confidence: 0.85, dueDate: "2026-03-01T00:00:00Z" },
        { title: "Task C", priority: "medium", confidence: 0.9, description: "Details for C" },
      ],
    });

    const store = makeMockStore();
    const eventBus = new TypedEventBus();
    const events: unknown[] = [];
    eventBus.on("scheduler:task_extracted", (payload) => events.push(payload));

    const deps = makeDeps({ extractFn, store, eventBus });
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("multi-task conversation", "tg:default:peer:user1");

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("test-uuid-001");
    expect(result[1].id).toBe("test-uuid-002");
    expect(result[2].id).toBe("test-uuid-003");

    expect(store.addTask).toHaveBeenCalledTimes(3);
    expect(store.tasks).toHaveLength(3);

    expect(events).toHaveLength(3);

    // Verify individual task properties
    expect(result[1].dueDate).toBe("2026-03-01T00:00:00Z");
    expect(result[2].description).toBe("Details for C");
  });

  it("extract uses default UUID and Date.now when generators not provided", async () => {
    const extractFn: ExtractionFn = async () => ({
      tasks: [{ title: "Test", priority: "medium", confidence: 0.9 }],
    });
    const store = makeMockStore();

    // Don't pass generateId or nowMs — use defaults
    const deps: TaskExtractorDeps = {
      extractFn,
      store,
      logger: makeMockLogger(),
      config: { enabled: true, confidenceThreshold: 0.5 },
      eventBus: new TypedEventBus(),
    };
    const extractor = createTaskExtractor(deps);

    const result = await extractor.extract("text", "tg:default:peer:user1");

    expect(result).toHaveLength(1);
    // UUID format: 8-4-4-4-12 hex chars
    expect(result[0].id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
    expect(result[0].createdAtMs).toBeGreaterThan(0);
  });
});
