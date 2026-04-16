import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveAgentModel, setupSingleAgent } from "./setup-agents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("setup-agents wiring", () => {
  it("passes skillRegistry to createPiExecutor deps (regression guard)", () => {
    const source = readFileSync(join(__dirname, "setup-agents.ts"), "utf-8");

    // Verify skillRegistry is created
    expect(source).toContain("const skillRegistry = createSkillRegistry(");

    // Verify skillRegistry is passed in the createPiExecutor deps object.
    // The deps object spans from "createPiExecutor(effectiveConfig, {" to the closing "});"
    // skillRegistry must appear inside that span.
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    expect(depsStart).toBeGreaterThan(-1);
    expect(depsEnd).toBeGreaterThan(depsStart);

    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("skillRegistry");
  });
});

describe("setupAgents OutputGuard wiring", () => {
  it("passes outputGuard and canaryToken to createPiExecutor deps (OGUARD regression guard)", () => {
    const source = readFileSync(join(__dirname, "setup-agents.ts"), "utf-8");

    // Verify OutputGuard and canary token are created before the deps block
    expect(source).toContain("createOutputGuard()");
    expect(source).toContain("generateCanaryToken");

    // Verify both are passed inside the createPiExecutor deps object (not just anywhere in file)
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    expect(depsStart).toBeGreaterThan(-1);
    expect(depsEnd).toBeGreaterThan(depsStart);

    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("outputGuard");
    expect(depsBlock).toContain("canaryToken");
  });

  it("includes canary fallback derivation", () => {
    const source = readFileSync(join(__dirname, "setup-agents.ts"), "utf-8");
    expect(source).toContain("deriveCanaryFallback");
    expect(source).toContain("CANARY_SECRET");
  });
});

describe("resolveAgentModel", () => {
  it("resolves model: 'default' to models.defaultModel", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "anthropic" },
      { defaultModel: "claude-opus-4-20250115", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "claude-opus-4-20250115", provider: "anthropic" });
  });

  it("resolves provider: 'default' to models.defaultProvider", () => {
    const result = resolveAgentModel(
      { model: "claude-sonnet-4-5-20250929", provider: "default" },
      { defaultModel: "", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "claude-sonnet-4-5-20250929", provider: "openai" });
  });

  it("resolves both model and provider 'default' together", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "gpt-4o", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "gpt-4o", provider: "openai" });
  });

  it("falls back to claude-opus-4-6 / anthropic when defaults are empty", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "claude-opus-4-6", provider: "anthropic" });
  });

  it("resolves model: 'default' to provider-specific default for openai", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "openai" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "gpt-5.1-codex", provider: "openai" });
  });

  it("resolves model: 'default' to provider-specific default for xai", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "xai" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "grok-4-fast-non-reasoning", provider: "xai" });
  });

  it("resolves model: 'default' with provider: 'default' resolving to openai", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "", defaultProvider: "google" },
    );
    expect(result).toEqual({ model: "gemini-2.5-pro", provider: "google" });
  });

  it("falls back to anthropic default for unknown provider", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "unknown-provider" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "claude-opus-4-6", provider: "unknown-provider" });
  });

  it("modelsConfig.defaultModel takes priority over provider-specific default", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "openai" },
      { defaultModel: "custom-model", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "custom-model", provider: "openai" });
  });

  it("passes through non-'default' values unchanged", () => {
    const result = resolveAgentModel(
      { model: "claude-opus-4-20250115", provider: "anthropic" },
      { defaultModel: "gpt-4o", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "claude-opus-4-20250115", provider: "anthropic" });
  });

  it("handles case-insensitive 'Default' and 'DEFAULT'", () => {
    const result = resolveAgentModel(
      { model: "Default", provider: "DEFAULT" },
      { defaultModel: "gpt-4o", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "gpt-4o", provider: "openai" });
  });
});

describe("setup-agents skills directory creation", () => {
  it("creates agent skills directory before skill registry init (SKILL-DIR regression guard)", () => {
    const source = readFileSync(join(__dirname, "setup-agents.ts"), "utf-8");

    // agentSkillsDir must be created before createSkillRegistry is called
    const mkdirPos = source.indexOf("mkdirSync(agentSkillsDir");
    const registryPos = source.indexOf("const skillRegistry = createSkillRegistry(");
    expect(mkdirPos).toBeGreaterThan(-1);
    expect(registryPos).toBeGreaterThan(mkdirPos);
  });
});

// ---------------------------------------------------------------------------
// setupSingleAgent structural parity tests
// ---------------------------------------------------------------------------

describe("setupSingleAgent structural parity", () => {
  const source = readFileSync(join(__dirname, "setup-agents.ts"), "utf-8");

  it("setupSingleAgent is exported and is an async function", () => {
    expect(typeof setupSingleAgent).toBe("function");
    // Verify it is declared as async in source
    expect(source).toContain("export async function setupSingleAgent(");
  });

  it("SingleAgentResult has all required keys", () => {
    // Extract the SingleAgentResult interface block from source
    const interfaceStart = source.indexOf("export interface SingleAgentResult {");
    expect(interfaceStart).toBeGreaterThan(-1);
    const interfaceEnd = source.indexOf("}", interfaceStart);
    const interfaceBlock = source.slice(interfaceStart, interfaceEnd);

    // All 8 fields must be present
    expect(interfaceBlock).toContain("executor:");
    expect(interfaceBlock).toContain("workspaceDir:");
    expect(interfaceBlock).toContain("costTracker:");
    expect(interfaceBlock).toContain("budgetGuard:");
    expect(interfaceBlock).toContain("stepCounter:");
    expect(interfaceBlock).toContain("piSessionAdapter:");
    expect(interfaceBlock).toContain("skillWatcherHandle?:");
    expect(interfaceBlock).toContain("skillRegistry:");
  });

  it("setupAgents loop body delegates to setupSingleAgent", () => {
    // Find the for-loop in setupAgents (after the singleAgentDeps construction)
    const loopStart = source.indexOf("for (const [agentId, agentConfig] of Object.entries(agents))");
    expect(loopStart).toBeGreaterThan(-1);

    // Find the end of the for-loop block
    const afterLoop = source.indexOf("const defaultAgentId", loopStart);
    expect(afterLoop).toBeGreaterThan(loopStart);

    const loopBody = source.slice(loopStart, afterLoop);

    // Loop body must call setupSingleAgent
    expect(loopBody).toContain("setupSingleAgent(");

    // Loop body must NOT contain inline executor creation (that logic is now in setupSingleAgent)
    expect(loopBody).not.toContain("createPiExecutor(");
    expect(loopBody).not.toContain("createCircuitBreaker(");
    expect(loopBody).not.toContain("createBudgetGuard(");
    expect(loopBody).not.toContain("createCostTracker(");
  });

  it("setupSingleAgent validates config with PerAgentConfigSchema", () => {
    // Find setupSingleAgent function body
    const fnStart = source.indexOf("export async function setupSingleAgent(");
    expect(fnStart).toBeGreaterThan(-1);

    // The function body should contain PerAgentConfigSchema.parse
    const fnBody = source.slice(fnStart, source.indexOf("\nexport ", fnStart + 1));
    expect(fnBody).toContain("PerAgentConfigSchema.parse(");
  });

  it("AgentsResult includes singleAgentDeps field", () => {
    // Find AgentsResult interface
    const agentsResultStart = source.indexOf("export interface AgentsResult {");
    expect(agentsResultStart).toBeGreaterThan(-1);
    const agentsResultEnd = source.indexOf("}", agentsResultStart);
    const agentsResultBlock = source.slice(agentsResultStart, agentsResultEnd);

    expect(agentsResultBlock).toContain("singleAgentDeps: SingleAgentDeps");
  });

  it("SingleAgentDeps has all shared dependency fields", () => {
    // Extract the SingleAgentDeps interface block from source.
    // Use the next "export" keyword as the end boundary since the interface
    // contains nested braces (e.g., daemonTracingDefaults?: { ... }).
    const interfaceStart = source.indexOf("export interface SingleAgentDeps {");
    expect(interfaceStart).toBeGreaterThan(-1);
    const interfaceEnd = source.indexOf("\nexport ", interfaceStart + 1);
    const interfaceBlock = source.slice(interfaceStart, interfaceEnd);

    // At minimum these 7 required shared dependency fields
    expect(interfaceBlock).toContain("container:");
    expect(interfaceBlock).toContain("memoryAdapter:");
    expect(interfaceBlock).toContain("sessionStore:");
    expect(interfaceBlock).toContain("agentLogger:");
    expect(interfaceBlock).toContain("resolvedAgentDir:");
    expect(interfaceBlock).toContain("subAgentToolNames?:");
    expect(interfaceBlock).toContain("mcpToolsInherited:");
  });
});
