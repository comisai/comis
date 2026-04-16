import { describe, it, expect } from "vitest";
import {
  TaskPrioritySchema,
  TaskStatusSchema,
  ExtractedTaskSchema,
  TaskExtractionResultSchema,
} from "./task-types.js";

describe("TaskPrioritySchema", () => {
  it.each(["critical", "high", "medium", "low"])("accepts '%s'", (val) => {
    expect(TaskPrioritySchema.safeParse(val).success).toBe(true);
  });

  it("rejects invalid priority", () => {
    expect(TaskPrioritySchema.safeParse("urgent").success).toBe(false);
  });
});

describe("TaskStatusSchema", () => {
  it.each(["pending", "scheduled", "completed", "cancelled"])("accepts '%s'", (val) => {
    expect(TaskStatusSchema.safeParse(val).success).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(TaskStatusSchema.safeParse("in_progress").success).toBe(false);
  });
});

describe("ExtractedTaskSchema", () => {
  const validTask = {
    id: "task-1",
    title: "Deploy new version",
    description: "Deploy v2.0 to production",
    priority: "high" as const,
    source: {
      sessionKey: "tg:default:peer:user123",
      messageIndex: 5,
      extractedAt: Date.now(),
    },
    confidence: 0.95,
    createdAtMs: Date.now(),
  };

  it("parses valid task with defaults", () => {
    const result = ExtractedTaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.status).toBe("pending");
    expect(result.data.description).toBe("Deploy v2.0 to production");
  });

  it("parses task with all fields", () => {
    const result = ExtractedTaskSchema.safeParse({
      ...validTask,
      dueDate: "2026-03-15T12:00:00Z",
      status: "scheduled",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.dueDate).toBe("2026-03-15T12:00:00Z");
    expect(result.data.status).toBe("scheduled");
  });

  it("applies empty string default for description", () => {
    const { description: _, ...taskWithoutDesc } = validTask;
    const result = ExtractedTaskSchema.safeParse(taskWithoutDesc);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.description).toBe("");
  });

  it("rejects task with empty id", () => {
    expect(ExtractedTaskSchema.safeParse({ ...validTask, id: "" }).success).toBe(false);
  });

  it("rejects task with empty title", () => {
    expect(ExtractedTaskSchema.safeParse({ ...validTask, title: "" }).success).toBe(false);
  });

  it("rejects task with title exceeding 500 chars", () => {
    expect(ExtractedTaskSchema.safeParse({ ...validTask, title: "x".repeat(501) }).success).toBe(
      false,
    );
  });

  it("rejects confidence out of range", () => {
    expect(ExtractedTaskSchema.safeParse({ ...validTask, confidence: 1.1 }).success).toBe(false);
    expect(ExtractedTaskSchema.safeParse({ ...validTask, confidence: -0.1 }).success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(ExtractedTaskSchema.safeParse({ ...validTask, tags: ["deploy"] }).success).toBe(false);
  });

  it("rejects invalid source (missing sessionKey)", () => {
    const result = ExtractedTaskSchema.safeParse({
      ...validTask,
      source: { messageIndex: 0, extractedAt: Date.now() },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative messageIndex in source", () => {
    const result = ExtractedTaskSchema.safeParse({
      ...validTask,
      source: { ...validTask.source, messageIndex: -1 },
    });
    expect(result.success).toBe(false);
  });
});

describe("TaskExtractionResultSchema", () => {
  const validExtractionTask = {
    title: "Check server status",
    priority: "medium" as const,
    source: {
      sessionKey: "tg:default:peer:user456",
      messageIndex: 3,
      extractedAt: Date.now(),
    },
    confidence: 0.85,
  };

  it("parses valid extraction result", () => {
    const result = TaskExtractionResultSchema.safeParse({
      tasks: [validExtractionTask],
      reasoning: "User mentioned checking server status tomorrow",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tasks).toHaveLength(1);
    expect(result.data.reasoning).toBeDefined();
  });

  it("parses empty tasks array", () => {
    const result = TaskExtractionResultSchema.safeParse({ tasks: [] });
    expect(result.success).toBe(true);
  });

  it("omits id, createdAtMs, and status from extraction tasks", () => {
    // These fields should NOT be present in extraction results
    const result = TaskExtractionResultSchema.safeParse({
      tasks: [{ ...validExtractionTask, id: "task-1", createdAtMs: Date.now(), status: "pending" }],
    });
    // .omit removes the keys from the schema, so extra keys cause strict failure
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    const result = TaskExtractionResultSchema.safeParse({
      tasks: [],
      model: "gpt-4",
    });
    expect(result.success).toBe(false);
  });
});
