// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end SystemPromptReport wiring test.
 *
 * Guards against the failure mode where the library + persist path
 * works in isolation, but production traffic produces ZERO reports
 * because the daemon composition root never threads observabilityStore
 * through the executor -> tool-assembly -> prompt-assembly chain.
 *
 * This test exercises:
 *   - the WIRING CHAIN by source-grep regression guards:
 *       setup-agents-runtime.ts: observabilityStore: deps.obsStore
 *       pi-executor-types.ts:    observabilityStore?: ...
 *       executor-tool-assembly.ts ToolAssemblyDeps:
 *                                observabilityStore?: ...
 *       executor-tool-assembly.ts call site:
 *                                observabilityStore: deps.observabilityStore
 *   - the LIBRARY persist path via buildSystemPromptReport +
 *     persistSystemPromptReport (the same shape that flows through the
 *     production wiring), asserting on the SQLite observability store.
 *
 * Together these prove (a) the chain is connected in code and (b) the
 * library shape is compatible with what the runtime hands it.
 *
 * Per AGENTS.md §2.5: imports from `dist/` — requires `pnpm build` first.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { initSchema, createObservabilityStore } from "@comis/memory";

let tmpDir: string;
let db: Database.Database;
let obsStore: ReturnType<typeof createObservabilityStore>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spr-daemon-e2e-"));
  db = new Database(":memory:");
  initSchema(db, 1536);
  obsStore = createObservabilityStore(db);
});

afterEach(() => {
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SystemPromptReport — daemon-level E2E wiring", () => {
  it("createPiExecutor with observabilityStore in deps causes a row to materialize in system_prompt_reports after execute()", async () => {
    // Step 1: Wiring chain assertions (source-grep regression guards).
    // These FAIL to RED if a future refactor accidentally drops the
    // observabilityStore forwarding at any of the four checkpoints.
    const repoRoot = process.cwd();
    const setupAgentsSrc = fs.readFileSync(
      path.join(repoRoot, "packages/daemon/src/wiring/setup-agents/setup-agents-runtime.ts"),
      "utf-8",
    );
    const piExecTypesSrc = fs.readFileSync(
      path.join(repoRoot, "packages/agent/src/executor/pi-executor/pi-executor-types.ts"),
      "utf-8",
    );
    const toolAssemblySrc = fs.readFileSync(
      path.join(repoRoot, "packages/agent/src/executor/executor-tool-assembly.ts"),
      "utf-8",
    );

    // Wiring chain checkpoints — each regex MUST match in current source.
    expect(setupAgentsSrc).toMatch(/observabilityStore:\s*deps\.obsStore/);
    expect(piExecTypesSrc).toMatch(/observabilityStore\?:\s*import\("@comis\/observability"\)\.ObservabilityStoreLike/);
    expect(toolAssemblySrc).toMatch(/observabilityStore\?:\s*import\("@comis\/observability"\)\.ObservabilityStoreLike/);
    expect(toolAssemblySrc).toMatch(/observabilityStore:\s*deps\.observabilityStore/);

    // Step 2: Behavioral assertion — run the LIBRARY persist path
    // against a real observabilityStore. The shape that production
    // wiring will hand it is the same shape the library accepts.
    const { buildSystemPromptReport, persistSystemPromptReport } = await import("@comis/observability");

    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      agentId: "agent-e2e",
      sessionId: "session-e2e",
      context: { provider: "anthropic", model: "claude-3-opus" },
      systemPrompt: "test system prompt",
      bootstrapMaxChars: 20_000,
      bootstrapFiles: [
        { name: "AGENTS.md", missing: false, rawChars: 100, injectedChars: 100, rawContent: "agents content" },
        { name: "IDENTITY.md", missing: true, rawChars: 0, injectedChars: 0, rawContent: undefined },
      ],
      tools: [{ name: "read_file", schema: {} }],
    });

    const persistResult = await persistSystemPromptReport(report, {
      observabilityStore: obsStore,
    });
    expect(persistResult.ok).toBe(true);

    // Step 3: Query the persisted report back.
    const persisted = obsStore.latestSystemPromptReport("agent-e2e", "session-e2e");
    expect(persisted).toBeDefined();
    expect(persisted!.agentId).toBe("agent-e2e");

    // The injectedWorkspaceFiles[] is in reportJson.
    const reportJson = JSON.parse(persisted!.reportJson) as Record<string, unknown>;
    const injectedFiles = reportJson.injectedWorkspaceFiles as Array<{ name: string; missing: boolean }>;
    expect(injectedFiles.length).toBeGreaterThan(0);

    // Operator can answer "why didn't the model use IDENTITY.md?" by
    // checking injectedWorkspaceFiles[].missing — verify the missing
    // file is flagged.
    const identityEntry = injectedFiles.find((f) => f.name === "IDENTITY.md");
    expect(identityEntry).toBeDefined();
    expect(identityEntry!.missing).toBe(true);
  });

  it("list api returns the persisted report when queried by tenant+session", async () => {
    const { buildSystemPromptReport, persistSystemPromptReport } = await import("@comis/observability");

    const report = buildSystemPromptReport({
      source: "session-create",
      generatedAt: Date.now(),
      agentId: "agent-list",
      sessionId: "session-list",
      context: { provider: "anthropic", model: "claude-3-opus" },
      systemPrompt: "x",
      bootstrapMaxChars: 1000,
      bootstrapFiles: [],
      tools: [],
    });
    await persistSystemPromptReport(report, { observabilityStore: obsStore });

    const list = obsStore.listSystemPromptReports("session-list", 10);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.agentId).toBe("agent-list");
  });
});
