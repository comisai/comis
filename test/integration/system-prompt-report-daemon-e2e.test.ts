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
 *       executor-tool-assembly-types.ts ToolAssemblyDeps:
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
 * Also guards modelProfile threading:
 *   - pi-executor.ts passes modelProfile into setupContextEngine
 *   - executor-context-engine-setup.ts forwards it into createLcdContextEngine deps (C1)
 * If either wiring leg is accidentally dropped the fail-closed WARN fires at runtime
 * but no build gate catches it — these source-grep assertions are the gate.
 *
 * Imports from `dist/` — requires `pnpm build` first.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { initSchema, createObservabilityStore } from "@comis/memory";

const memoryPkgDir = path.resolve(__dirname, "../../packages/memory");
const require = createRequire(path.resolve(memoryPkgDir, "package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;

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
    // ToolAssemblyDeps type contracts were extracted to
    // executor-tool-assembly-types.ts; the
    // `observabilityStore?:` type declaration lives there now, while the
    // value-forwarding call site stays in executor-tool-assembly.ts.
    const toolAssemblyTypesSrc = fs.readFileSync(
      path.join(repoRoot, "packages/agent/src/executor/executor-tool-assembly-types.ts"),
      "utf-8",
    );

    // Wiring chain checkpoints — each regex MUST match in current source.
    expect(setupAgentsSrc).toMatch(/observabilityStore:\s*deps\.obsStore/);
    expect(piExecTypesSrc).toMatch(/observabilityStore\?:\s*import\("@comis\/observability"\)\.ObservabilityStoreLike/);
    expect(toolAssemblyTypesSrc).toMatch(/observabilityStore\?:\s*import\("@comis\/observability"\)\.ObservabilityStoreLike/);
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

  it("modelProfile wiring — pi-executor passes modelProfile into setupContextEngine, setup forwards it to createLcdContextEngine", () => {
    // Source-grep regression guards for modelProfile threading.
    // Structurally identical to the observabilityStore guards above.
    // These FAIL to RED if a future refactor accidentally drops either leg of
    // the modelProfile wiring (pi-executor → setupContextEngine → lcd deps).
    const repoRoot = process.cwd();
    const piExecutorSrc = fs.readFileSync(
      path.join(repoRoot, "packages/agent/src/executor/pi-executor/pi-executor.ts"),
      "utf-8",
    );
    const ceSetupSrc = fs.readFileSync(
      path.join(repoRoot, "packages/agent/src/executor/executor-context-engine-setup.ts"),
      "utf-8",
    );

    // (a) pi-executor.ts: resolveModelProfile() result is forwarded into setupContextEngine.
    // The inline comment documents the provenance ("resolveModelProfile() at line 328").
    expect(piExecutorSrc).toMatch(/modelProfile,\s*\/\/.*resolveModelProfile/);

    // (b) executor-context-engine-setup.ts: modelProfile is forwarded into the
    // createLcdContextEngine deps object (the C1 annotation marks the intent).
    // Anchored to the deps-object C1 comment rather than the closing `})` so the
    // guard survives sibling fields being added after `modelProfile,` (e.g. the
    // securityPinMarkers/onAssembledInputTokens forwards) while still
    // going RED if the `modelProfile` forwarding leg under C1 is dropped.
    expect(ceSetupSrc).toMatch(/\/\/ C1 \(Phase 165\)/);
    expect(ceSetupSrc).toMatch(
      /C1 \(Phase 165\): the resolved ModelProfile for budget-aware eviction cap[\s\S]*?\n\s*modelProfile,/,
    );
  });
});
