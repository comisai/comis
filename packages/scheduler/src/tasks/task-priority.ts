import type { TaskPriority } from "./task-types.js";

/**
 * Priority scoring result for a task.
 */
export interface PriorityScore {
  /** Urgency score based on due date proximity (0-100) */
  urgencyScore: number;
  /** Importance score based on task priority level (0-100) */
  importanceScore: number;
  /** Weighted average of urgency and importance, scaled by confidence (0-100) */
  combinedScore: number;
}

/**
 * Weight mapping from TaskPriority to numeric importance score.
 */
export const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

const MS_PER_DAY = 86_400_000;

/**
 * Score a task's priority based on urgency (due date proximity) and importance (priority level),
 * scaled by extraction confidence.
 *
 * - importanceScore: Derived from PRIORITY_WEIGHTS lookup.
 * - urgencyScore: Without dueDate, defaults to importanceScore * 0.5.
 *   With dueDate, uses stepped thresholds based on days until due.
 * - combinedScore: urgency * 0.6 + importance * 0.4, scaled by confidence.
 */
export function scorePriority(
  task: { priority: TaskPriority; dueDate?: string; confidence: number },
  nowMs?: number,
): PriorityScore {
  const importance = PRIORITY_WEIGHTS[task.priority];
  let urgency: number;

  if (task.dueDate === undefined) {
    urgency = importance * 0.5;
  } else {
    const now = nowMs ?? Date.now();
    const daysUntilDue = (Date.parse(task.dueDate) - now) / MS_PER_DAY;

    if (daysUntilDue < 0) {
      urgency = 100;
    } else if (daysUntilDue <= 1) {
      urgency = 90;
    } else if (daysUntilDue <= 3) {
      urgency = 70;
    } else if (daysUntilDue <= 7) {
      urgency = 50;
    } else if (daysUntilDue <= 30) {
      urgency = 30;
    } else {
      urgency = 10;
    }
  }

  const rawCombined = Math.round(urgency * 0.6 + importance * 0.4);
  const combined = Math.round(rawCombined * task.confidence);

  return {
    urgencyScore: urgency,
    importanceScore: importance,
    combinedScore: combined,
  };
}

/**
 * Rank tasks by combined priority score (descending). Does not mutate the input array.
 */
export function rankTasks<
  T extends { priority: TaskPriority; dueDate?: string; confidence: number },
>(tasks: T[], nowMs?: number): T[] {
  return [...tasks].sort((a, b) => {
    const scoreA = scorePriority(a, nowMs).combinedScore;
    const scoreB = scorePriority(b, nowMs).combinedScore;
    return scoreB - scoreA;
  });
}
