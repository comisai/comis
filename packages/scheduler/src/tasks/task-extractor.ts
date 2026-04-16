import type { TypedEventBus } from "@comis/core";
import { randomUUID } from "node:crypto";
import type { TaskStore } from "./task-store.js";
import type { ExtractedTask } from "./task-types.js";
import { ExtractedTaskSchema, TaskExtractionResultSchema } from "./task-types.js";

/**
 * Pluggable extraction function type.
 *
 * In production this wraps an LLM call; in tests it returns canned data.
 * The returned tasks contain only the fields the LLM produces (no id, status,
 * createdAtMs, or source -- those are system-assigned by the extractor).
 */
export type ExtractionFn = (
  conversationText: string,
  sessionKey: string,
) => Promise<{
  tasks: Array<{
    title: string;
    description?: string;
    dueDate?: string;
    priority: "critical" | "high" | "medium" | "low";
    confidence: number;
  }>;
  reasoning?: string;
}>;

/**
 * Dependencies injected into the TaskExtractor.
 */
export interface TaskExtractorDeps {
  /** Pluggable extraction (LLM call in production, mock in tests) */
  extractFn: ExtractionFn;
  /** Persistence for extracted tasks */
  store: TaskStore;
  /** Logger for warnings and errors */
  logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  /** Feature flag and confidence threshold */
  config: { enabled: boolean; confidenceThreshold: number };
  /** Event bus for scheduler:task_extracted events */
  eventBus: TypedEventBus;
  /** Injectable ID generator (defaults to crypto.randomUUID) */
  generateId?: () => string;
  /** Injectable clock (defaults to Date.now) */
  nowMs?: () => number;
}

/**
 * TaskExtractor: Conversation-to-task extraction pipeline.
 */
export interface TaskExtractor {
  /** Extract tasks from conversation text. Returns validated, persisted tasks. */
  extract(conversationText: string, sessionKey: string): Promise<ExtractedTask[]>;
  /** Return the system prompt for LLM task extraction. */
  getExtractionPrompt(): string;
}

/**
 * Create a TaskExtractor that validates, filters, persists, and emits events
 * for extracted tasks. The actual extraction is delegated to the pluggable
 * ExtractionFn, decoupling the pipeline from any specific LLM provider.
 */
export function createTaskExtractor(deps: TaskExtractorDeps): TaskExtractor {
  const {
    extractFn,
    store,
    logger,
    config,
    eventBus,
    generateId = randomUUID,
    nowMs = Date.now,
  } = deps;

  async function extract(conversationText: string, sessionKey: string): Promise<ExtractedTask[]> {
    if (!config.enabled) {
      return [];
    }

    const raw = await extractFn(conversationText, sessionKey);

    // Enrich raw tasks with source before schema validation
    const enriched = {
      ...raw,
      tasks: raw.tasks.map((t) => ({
        ...t,
        source: {
          sessionKey,
          messageIndex: 0,
          extractedAt: nowMs(),
        },
      })),
    };

    // Validate through TaskExtractionResultSchema
    const parseResult = TaskExtractionResultSchema.safeParse(enriched);
    if (!parseResult.success) {
      logger.warn({
        errors: parseResult.error.issues,
        hint: "LLM returned invalid task extraction format; check extraction prompt or model behavior",
        errorKind: "validation" as const,
      }, "Task extraction result failed validation");
      return [];
    }

    const validatedResult = parseResult.data;

    // Filter by confidence threshold
    const passingTasks = validatedResult.tasks.filter(
      (t) => t.confidence >= config.confidenceThreshold,
    );

    const savedTasks: ExtractedTask[] = [];

    for (const rawTask of passingTasks) {
      const now = nowMs();
      const id = generateId();

      // Build full ExtractedTask with system-assigned fields
      const fullTask = ExtractedTaskSchema.parse({
        ...rawTask,
        id,
        createdAtMs: now,
        status: "pending",
      });

      await store.addTask(fullTask);

      eventBus.emit("scheduler:task_extracted", {
        taskId: fullTask.id,
        title: fullTask.title,
        priority: fullTask.priority,
        confidence: fullTask.confidence,
        sessionKey,
        timestamp: now,
      });

      savedTasks.push(fullTask);
    }

    return savedTasks;
  }

  function getExtractionPrompt(): string {
    return `You are a task extraction assistant. Analyze the conversation and extract any commitments, deadlines, follow-ups, or actionable items.

Return a JSON object matching this exact format:
{
  "tasks": [
    {
      "title": "Short task title (max 500 chars)",
      "description": "Detailed description of what needs to be done",
      "dueDate": "ISO 8601 date string if a deadline was mentioned, omit if none",
      "priority": "critical | high | medium | low",
      "confidence": 0.0 to 1.0
    }
  ],
  "reasoning": "Brief explanation of why these tasks were extracted"
}

Rules:
- Extract only commitments, deadlines, and follow-ups that were clearly discussed.
- Assign priority based on context: "critical" for urgent/blocking items, "high" for important deadlines, "medium" for standard follow-ups, "low" for nice-to-haves.
- Assign confidence (0-1) based on how clearly the commitment was stated. Explicit "I will do X by Friday" = high confidence (0.9+). Vague "we should look into" = low confidence (0.3-0.5).
- If no actionable tasks are found, return: { "tasks": [], "reasoning": "No actionable commitments found" }
- Never hallucinate tasks not discussed in the conversation.
- Each task must have a title and priority at minimum.`;
  }

  return { extract, getExtractionPrompt };
}
