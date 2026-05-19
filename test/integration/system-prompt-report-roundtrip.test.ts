// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 45-04: SystemPromptReport end-to-end roundtrip integration.
 *
 * Tests the full build → persist → query cycle without spinning up a
 * full daemon process. Validates that:
 *
 *   1. After a prompt-assembly run, the report is emitted to the
 *      observability store with a non-zero `injectedWorkspaceFiles[]`
 *      array (matches the design's success criterion for TRAJ-05..07).
 *   2. With a bootstrap file deleted (missing on disk), the report
 *      shows that file with `missing: true` — directly gates ROADMAP
 *      Phase 45 success criterion #2: "Operator can answer 'why didn't
 *      the model use IDENTITY.md?' by checking injectedWorkspaceFiles[]".
 *
 * Per AGENTS.md §2.5: imports from dist/ — requires `pnpm build` first.
 * Vitest aliases @comis/* → packages/*\/dist/index.js.
 *
 * @module
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, createObservabilityStore } from "@comis/memory";
import {
  buildSystemPromptReport,
  persistSystemPromptReport,
  type BootstrapFileForReport,
  type SystemPromptReport,
} from "@comis/observability";

const AGENT_ID = "agent-1";
const SESSION_ID = "session-1";

function makeBootstrapFiles(opts: {
  identityMissing?: boolean;
  agentsContent?: string;
}): BootstrapFileForReport[] {
  return [
    {
      name: "AGENTS.md",
      missing: false,
      rawChars: (opts.agentsContent ?? "agents content").length,
      injectedChars: (opts.agentsContent ?? "agents content").length,
      rawContent: opts.agentsContent ?? "agents content",
    },
    {
      name: "IDENTITY.md",
      missing: opts.identityMissing ?? false,
      rawChars: opts.identityMissing ? 0 : 500,
      injectedChars: opts.identityMissing ? 0 : 500,
      rawContent: opts.identityMissing ? undefined : "identity content here",
    },
    {
      name: "USER.md",
      missing: false,
      rawChars: 100,
      injectedChars: 100,
      rawContent: "user content",
    },
  ];
}

describe("SystemPromptReport — build → persist → query roundtrip", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createObservabilityStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("report_emitted_after_one_prompt_run with non-empty injectedWorkspaceFiles[]", async () => {
    const bootstrapFiles = makeBootstrapFiles({});
    const report: SystemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: 1_700_000_000_000,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      context: {
        provider: "anthropic",
        model: "claude-3-opus",
      },
      systemPrompt: "# Project Context\nidentity content here\n## Silent Replies\nrest",
      bootstrapMaxChars: 20_000,
      bootstrapFiles,
      tools: [
        { name: "read_file", schema: { type: "object", properties: { path: { type: "string" } } } },
      ],
    });

    const result = await persistSystemPromptReport(report, {
      observabilityStore: store,
    });
    expect(result.ok).toBe(true);

    // Query the persisted report back.
    const persisted = store.latestSystemPromptReport(AGENT_ID, SESSION_ID);
    expect(persisted).toBeDefined();
    expect(persisted!.agentId).toBe(AGENT_ID);
    expect(persisted!.sessionId).toBe(SESSION_ID);

    const parsed = JSON.parse(persisted!.reportJson);
    expect(parsed.traceSchema).toBe("comis-system-prompt-report");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.injectedWorkspaceFiles).toHaveLength(3);
    // AGENTS.md / IDENTITY.md / USER.md all present
    const fileNames = parsed.injectedWorkspaceFiles.map((f: any) => f.name);
    expect(fileNames).toContain("AGENTS.md");
    expect(fileNames).toContain("IDENTITY.md");
    expect(fileNames).toContain("USER.md");
  });

  it("report_marks_missing_bootstrap_file_when_deleted (gates ROADMAP success criterion #2)", async () => {
    // Simulate IDENTITY.md being deleted from the workspace.
    const bootstrapFiles = makeBootstrapFiles({ identityMissing: true });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 1_700_000_000_000,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      systemPrompt: "system prompt body without identity content",
      bootstrapMaxChars: 20_000,
      bootstrapFiles,
      tools: [],
    });

    const result = await persistSystemPromptReport(report, {
      observabilityStore: store,
    });
    expect(result.ok).toBe(true);

    const persisted = store.latestSystemPromptReport(AGENT_ID, SESSION_ID);
    expect(persisted).toBeDefined();

    const parsed = JSON.parse(persisted!.reportJson);
    const identityEntry = parsed.injectedWorkspaceFiles.find(
      (f: any) => f.name === "IDENTITY.md",
    );
    expect(identityEntry).toBeDefined();
    // This is the load-bearing assertion for ROADMAP success criterion #2:
    // an operator inspecting the report can answer "why didn't the model
    // use IDENTITY.md?" by reading `missing: true`.
    expect(identityEntry.missing).toBe(true);
    expect(identityEntry.rawChars).toBe(0);
    expect(identityEntry.sha256).toBeUndefined();

    // AGENTS.md still present
    const agentsEntry = parsed.injectedWorkspaceFiles.find(
      (f: any) => f.name === "AGENTS.md",
    );
    expect(agentsEntry.missing).toBe(false);
    expect(agentsEntry.rawChars).toBeGreaterThan(0);
  });

  it("list_returns_most_recent_reports_in_descending_order", async () => {
    // Insert 3 reports at different times.
    for (let i = 0; i < 3; i += 1) {
      const report = buildSystemPromptReport({
        source: "run",
        generatedAt: 1_000_000 + i,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        context: { runId: `run-${i}` },
        systemPrompt: `prompt ${i}`,
        bootstrapMaxChars: 20_000,
        bootstrapFiles: makeBootstrapFiles({}),
        tools: [],
      });
      const r = await persistSystemPromptReport(report, { observabilityStore: store });
      expect(r.ok).toBe(true);
    }

    const list = store.listSystemPromptReports(SESSION_ID, 10);
    expect(list).toHaveLength(3);
    expect(list[0]!.generatedAt).toBe(1_000_002);
    expect(list[2]!.generatedAt).toBe(1_000_000);
    expect(list[0]!.runId).toBe("run-2");
  });

  it("redaction_applied_to_persisted_report_json (45-02 pipeline)", async () => {
    // Build a report with a credential-shaped string inside a tool name
    // (mimicking an accidentally-named tool).
    const bootstrapFiles = makeBootstrapFiles({});
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 1_700_000_000_000,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      systemPrompt: "system prompt body",
      bootstrapMaxChars: 20_000,
      bootstrapFiles,
      tools: [
        {
          name: "leaky-tool-sk-ant-api03-AABBCCDDEEFFGGHHIIJJKKLL-very-long-tail-suffix-here",
          schema: { type: "object" },
        },
      ],
    });

    await persistSystemPromptReport(report, { observabilityStore: store });
    const persisted = store.latestSystemPromptReport(AGENT_ID, SESSION_ID);
    expect(persisted).toBeDefined();
    // The raw secret-shaped substring must not survive in the persisted
    // JSON — the 45-02 sanitize pipeline applies before INSERT.
    expect(persisted!.reportJson).not.toContain(
      "sk-ant-api03-AABBCCDDEEFFGGHHIIJJKKLL-very-long-tail-suffix-here",
    );
  });

  it("RAG-sections-only run persists memoryInjection AND bootstrap budgets (TRAJ-FIX-08, TRAJ-FIX-09)", async () => {
    // Plan 45.1-05 (M4 + M5 integration): a turn where the hybrid
    // memory injector emits RAG sections but no inline-memory chunk.
    // The persisted report must:
    //   - carry a non-undefined memoryInjection block (M4 / TRAJ-FIX-08)
    //   - carry bootstrapMaxChars + bootstrapTotalMaxChars knobs
    //     (M5 / TRAJ-FIX-09)
    //
    // Driven via buildSystemPromptReport directly (not the agent-
    // package call site) — the unit-level prompt-assembly test from
    // task 4 covers the predicate; this integration case verifies the
    // round-trip through sanitize → SQLite INSERT → JSON.parse.
    const sectionA = "RAG section body A: useful context here";
    const sectionB = "RAG section body B: more useful context";
    const bootstrapFiles = makeBootstrapFiles({});
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 1_700_000_000_001,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      context: { runId: "run-memory-only" },
      systemPrompt: "system prompt body for RAG-sections-only run",
      bootstrapMaxChars: 25_000,
      bootstrapTotalMaxChars: 60_000,
      bootstrapFiles,
      tools: [],
      memoryInjection: {
        ragHits: 2,
        charsInjected: sectionA.length + sectionB.length,
        trustTags: [],
      },
    });

    const result = await persistSystemPromptReport(report, { observabilityStore: store });
    expect(result.ok).toBe(true);

    const persisted = store.latestSystemPromptReport(AGENT_ID, SESSION_ID);
    expect(persisted).toBeDefined();

    const parsed = JSON.parse(persisted!.reportJson);

    // M4 / TRAJ-FIX-08: memoryInjection block populated for sections-only.
    expect(parsed.memoryInjection).toBeDefined();
    expect(parsed.memoryInjection.ragHits).toBeGreaterThan(0);
    expect(parsed.memoryInjection.charsInjected).toBeGreaterThan(0);

    // M5 / TRAJ-FIX-09: bootstrap-budget knobs persisted through the JSON.
    expect(parsed.bootstrapMaxChars).toBe(25_000);
    expect(parsed.bootstrapTotalMaxChars).toBe(60_000);
  });
});
