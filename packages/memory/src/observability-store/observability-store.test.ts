// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 45-04: ObservabilityStore SystemPromptReport CRUD smoke tests.
 *
 * Uses better-sqlite3 in-memory DB so that `initSchema(db, 1536)`
 * creates the full schema before exercising the store. Three
 * behavior-named cases per the plan: insert + retrieve latest,
 * insert + list with limit, and validation degrade.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../schema.js";
import { createObservabilityStore } from "./index.js";
import type {
  ObservabilityStore,
  SystemPromptReportRow,
} from "./observability-store-types.js";

function makeRow(overrides: Partial<SystemPromptReportRow> = {}): SystemPromptReportRow {
  return {
    agentId: "agent-1",
    tenantId: null,
    sessionId: "session-1",
    runId: null,
    generatedAt: 1_700_000_000_000,
    provider: "anthropic",
    model: "claude-3-opus",
    systemChars: 100,
    systemSha256: "deadbeef",
    reportJson: '{"k":1}',
    ...overrides,
  };
}

describe("ObservabilityStore — SystemPromptReport CRUD", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("inserts a SystemPromptReport row and retrieves the latest by (agentId, sessionId)", () => {
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_500, runId: "run-c" }));

    const latest = store.latestSystemPromptReport("agent-1", "session-1");
    expect(latest).toBeDefined();
    expect(latest!.generatedAt).toBe(2_000);
    expect(latest!.runId).toBe("run-b");
  });

  it("returns undefined from latestSystemPromptReport when no rows match", () => {
    const latest = store.latestSystemPromptReport("nonexistent-agent", "nonexistent-session");
    expect(latest).toBeUndefined();
  });

  it("lists SystemPromptReports for a session in descending generatedAt order with a limit", () => {
    for (let i = 0; i < 15; i += 1) {
      store.insertSystemPromptReport(makeRow({ generatedAt: 1_000 + i, runId: `run-${i}` }));
    }
    const rows = store.listSystemPromptReports("session-1", 10);
    expect(rows).toHaveLength(10);
    // Descending order
    expect(rows[0]!.generatedAt).toBe(1_014);
    expect(rows[9]!.generatedAt).toBe(1_005);
  });

  it("returns empty array from listSystemPromptReports when no rows match", () => {
    const rows = store.listSystemPromptReports("nonexistent-session", 10);
    expect(rows).toEqual([]);
  });

  it("supports null tenantId and runId via the nullable composite-key columns", () => {
    store.insertSystemPromptReport(
      makeRow({ tenantId: null, runId: null, generatedAt: 100 }),
    );
    const latest = store.latestSystemPromptReport("agent-1", "session-1");
    expect(latest?.tenantId).toBeNull();
    expect(latest?.runId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Plan 45.1-05 (TRAJ-FIX-07): runId-in-SQL narrowing — push the optional
  // runId filter into the WHERE clause so an older row with the matching
  // runId is returned even when a newer row (different runId) exists.
  // -------------------------------------------------------------------------
  it("latestSystemPromptReport with runId narrows to the named run (TRAJ-FIX-07)", () => {
    // Three rows: latest-by-generatedAt is run-b (gen=2000), but we ask for run-a (gen=1000).
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_500, runId: "run-c" }));

    const result = store.latestSystemPromptReport("agent-1", "session-1", "run-a");
    expect(result?.runId).toBe("run-a");
    expect(result?.generatedAt).toBe(1_000);
  });

  it("latestSystemPromptReport with runId for a non-existent run returns undefined (TRAJ-FIX-07)", () => {
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    const result = store.latestSystemPromptReport("agent-1", "session-1", "run-nonexistent");
    expect(result).toBeUndefined();
  });

  it("latestSystemPromptReport without runId still returns the most-recent row (TRAJ-FIX-07 regression guard)", () => {
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_500, runId: "run-c" }));
    const result = store.latestSystemPromptReport("agent-1", "session-1");
    expect(result?.runId).toBe("run-b");
    expect(result?.generatedAt).toBe(2_000);
  });
});
