import { describe, it, expect } from "vitest";
import type { TaskPriority } from "./task-types.js";
import { scorePriority, rankTasks, PRIORITY_WEIGHTS } from "./task-priority.js";

const MS_PER_DAY = 86_400_000;

/** Fixed "now" for deterministic tests: 2026-02-08T00:00:00Z */
const NOW = Date.parse("2026-02-08T00:00:00Z");

function makeTask(
  priority: TaskPriority,
  dueDate?: string,
  confidence = 1,
): { priority: TaskPriority; dueDate?: string; confidence: number } {
  return { priority, dueDate, confidence };
}

describe("PRIORITY_WEIGHTS", () => {
  it("maps each priority to correct weight", () => {
    expect(PRIORITY_WEIGHTS.critical).toBe(100);
    expect(PRIORITY_WEIGHTS.high).toBe(75);
    expect(PRIORITY_WEIGHTS.medium).toBe(50);
    expect(PRIORITY_WEIGHTS.low).toBe(25);
  });
});

describe("scorePriority", () => {
  it("critical with no due date -> importanceScore=100, urgencyScore=50", () => {
    const score = scorePriority(makeTask("critical"), NOW);
    expect(score.importanceScore).toBe(100);
    expect(score.urgencyScore).toBe(50);
  });

  it("low with no due date -> importanceScore=25, urgencyScore=12.5", () => {
    const score = scorePriority(makeTask("low"), NOW);
    expect(score.importanceScore).toBe(25);
    expect(score.urgencyScore).toBe(12.5);
  });

  it("high with no due date -> importanceScore=75, urgencyScore=37.5", () => {
    const score = scorePriority(makeTask("high"), NOW);
    expect(score.importanceScore).toBe(75);
    expect(score.urgencyScore).toBe(37.5);
  });

  it("overdue task -> urgencyScore=100", () => {
    const yesterday = new Date(NOW - MS_PER_DAY).toISOString();
    const score = scorePriority(makeTask("medium", yesterday), NOW);
    expect(score.urgencyScore).toBe(100);
  });

  it("due in 1 day -> urgencyScore=90", () => {
    // 12 hours from now (within 1 day)
    const soon = new Date(NOW + MS_PER_DAY * 0.5).toISOString();
    const score = scorePriority(makeTask("medium", soon), NOW);
    expect(score.urgencyScore).toBe(90);
  });

  it("due in 2 days -> urgencyScore=70", () => {
    const twoDays = new Date(NOW + MS_PER_DAY * 2).toISOString();
    const score = scorePriority(makeTask("medium", twoDays), NOW);
    expect(score.urgencyScore).toBe(70);
  });

  it("due in 5 days -> urgencyScore=50", () => {
    const fiveDays = new Date(NOW + MS_PER_DAY * 5).toISOString();
    const score = scorePriority(makeTask("medium", fiveDays), NOW);
    expect(score.urgencyScore).toBe(50);
  });

  it("due in 15 days -> urgencyScore=30", () => {
    const fifteenDays = new Date(NOW + MS_PER_DAY * 15).toISOString();
    const score = scorePriority(makeTask("medium", fifteenDays), NOW);
    expect(score.urgencyScore).toBe(30);
  });

  it("due in 60 days -> urgencyScore=10", () => {
    const sixtyDays = new Date(NOW + MS_PER_DAY * 60).toISOString();
    const score = scorePriority(makeTask("medium", sixtyDays), NOW);
    expect(score.urgencyScore).toBe(10);
  });

  it("combined score weights urgency 60%, importance 40%", () => {
    // Critical (importance=100) overdue (urgency=100), confidence=1
    const yesterday = new Date(NOW - MS_PER_DAY).toISOString();
    const score = scorePriority(makeTask("critical", yesterday, 1), NOW);
    // combined = round(100*0.6 + 100*0.4) * 1 = 100
    expect(score.combinedScore).toBe(100);

    // Low (importance=25) due in 60 days (urgency=10), confidence=1
    const farFuture = new Date(NOW + MS_PER_DAY * 60).toISOString();
    const scoreLow = scorePriority(makeTask("low", farFuture, 1), NOW);
    // combined = round(10*0.6 + 25*0.4) * 1 = round(6 + 10) = 16
    expect(scoreLow.combinedScore).toBe(16);
  });

  it("confidence scaling: score * 0.5 confidence = half the score", () => {
    const score1 = scorePriority(makeTask("critical", undefined, 1), NOW);
    const score05 = scorePriority(makeTask("critical", undefined, 0.5), NOW);
    // combinedScore at confidence=1: round(50*0.6 + 100*0.4) = round(30+40) = 70
    expect(score1.combinedScore).toBe(70);
    // combinedScore at confidence=0.5: round(70 * 0.5) = 35
    expect(score05.combinedScore).toBe(35);
  });

  it("zero confidence produces zero combined score", () => {
    const score = scorePriority(makeTask("critical", undefined, 0), NOW);
    expect(score.combinedScore).toBe(0);
    // Urgency and importance are still computed
    expect(score.importanceScore).toBe(100);
    expect(score.urgencyScore).toBe(50);
  });

  it("due exactly at now boundary -> urgencyScore=90 (within 1 day)", () => {
    const exactlyNow = new Date(NOW).toISOString();
    const score = scorePriority(makeTask("medium", exactlyNow), NOW);
    // daysUntilDue = 0, which is <= 1 day
    expect(score.urgencyScore).toBe(90);
  });
});

describe("rankTasks", () => {
  it("sorts tasks descending by combined score", () => {
    const tasks = [makeTask("low"), makeTask("critical"), makeTask("medium"), makeTask("high")];
    const ranked = rankTasks(tasks, NOW);

    expect(ranked[0].priority).toBe("critical");
    expect(ranked[1].priority).toBe("high");
    expect(ranked[2].priority).toBe("medium");
    expect(ranked[3].priority).toBe("low");
  });

  it("does not mutate input array", () => {
    const tasks = [makeTask("low"), makeTask("critical")];
    const original = [...tasks];
    rankTasks(tasks, NOW);

    expect(tasks).toEqual(original);
    expect(tasks[0].priority).toBe("low");
  });

  it("critical overdue ranks higher than low future-due", () => {
    const yesterday = new Date(NOW - MS_PER_DAY).toISOString();
    const farFuture = new Date(NOW + MS_PER_DAY * 60).toISOString();

    const tasks = [makeTask("low", farFuture), makeTask("critical", yesterday)];
    const ranked = rankTasks(tasks, NOW);

    expect(ranked[0].priority).toBe("critical");
    expect(ranked[1].priority).toBe("low");
  });

  it("returns empty array for empty input", () => {
    expect(rankTasks([], NOW)).toEqual([]);
  });

  it("handles single task", () => {
    const tasks = [makeTask("medium")];
    const ranked = rankTasks(tasks, NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].priority).toBe("medium");
  });
});
