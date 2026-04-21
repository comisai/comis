// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Task priority levels for extracted tasks.
 */
export const TaskPrioritySchema = z.enum(["critical", "high", "medium", "low"]);

export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * Task status lifecycle.
 */
export const TaskStatusSchema = z.enum(["pending", "scheduled", "completed", "cancelled"]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * A task extracted from conversation by the LLM.
 */
export const ExtractedTaskSchema = z.strictObject({
    /** Unique task identifier */
    id: z.string().min(1),
    /** Short title for the task */
    title: z.string().min(1).max(500),
    /** Detailed description */
    description: z.string().default(""),
    /** Optional due date (ISO 8601) */
    dueDate: z.string().optional(),
    /** Task priority */
    priority: TaskPrioritySchema,
    /** Source provenance */
    source: z.strictObject({
        /** Session key where task was extracted */
        sessionKey: z.string().min(1),
        /** Message index within the session */
        messageIndex: z.number().int().nonnegative(),
        /** Timestamp when extraction occurred (ms since epoch) */
        extractedAt: z.number().int().positive(),
      }),
    /** Confidence score from the LLM extraction (0-1) */
    confidence: z.number().min(0).max(1),
    /** Task lifecycle status */
    status: TaskStatusSchema.default("pending"),
    /** Task creation timestamp (ms since epoch) */
    createdAtMs: z.number().int().positive(),
  });

export type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;

/**
 * Result from the LLM task extraction.
 * Tasks here lack id, createdAtMs, and status (assigned by the system).
 */
export const TaskExtractionResultSchema = z.strictObject({
    /** Extracted tasks (without system-assigned fields) */
    tasks: z.array(ExtractedTaskSchema.omit({ id: true, createdAtMs: true, status: true })),
    /** Optional reasoning from the LLM about extraction */
    reasoning: z.string().optional(),
  });

export type TaskExtractionResult = z.infer<typeof TaskExtractionResultSchema>;
