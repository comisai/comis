// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
import {
  resolveAgentModel,
  setupSingleAgent,
} from "./setup-agents.js";
// Phase 8 plan 01: selectOAuthCredentialStore moved to @comis/agent
// (RESEARCH override 4 — CLI cannot import from @comis/daemon).
import { selectOAuthCredentialStore } from "@comis/agent";
import type { OAuthCredentialStorePort, SecretsCrypto } from "@comis/core";
import type Database from "better-sqlite3";

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
  // Behavioral assertions: avoid pinning literal model IDs (which would
  // re-introduce per-pi-ai-release staleness — the bug Phase 2 closes).
  // Tests assert catalog membership and the priority chain (explicit YAML
  // wins over catalog heuristic; explicit per-agent value wins over both).

  it("resolves model: 'default' to models.defaultModel (explicit YAML wins)", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "anthropic" },
      { defaultModel: "claude-opus-4-20250115", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "claude-opus-4-20250115", provider: "anthropic" });
  });

  it("resolves provider: 'default' to models.defaultProvider (explicit YAML wins)", () => {
    const result = resolveAgentModel(
      { model: "claude-sonnet-4-5-20250929", provider: "default" },
      { defaultModel: "", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "claude-sonnet-4-5-20250929", provider: "openai" });
  });

  it("resolves both model and provider 'default' together via explicit YAML", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "gpt-4o", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "gpt-4o", provider: "openai" });
  });

  it("when both YAML defaults are empty, falls back to catalog heuristic with valid (provider, model)", () => {
    // No explicit YAML -> catalog heuristic: most-populated native provider,
    // mid-tier model. Asserts the result is a real pi-ai catalog entry.
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "", defaultProvider: "" },
    );

    // Provider must be a real pi-ai native provider.
    expect(getProviders()).toContain(result.provider as KnownProvider);
    // Model must exist in that provider's catalog.
    const catalogIds = new Set(getModels(result.provider as KnownProvider).map((m) => m.id));
    expect(catalogIds.has(result.model)).toBe(true);
  });

  it("resolves model: 'default' for known provider via catalog (catalog-driven, no hardcoded literal)", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "openai" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("openai");
    // Model must be a real OpenAI catalog entry.
    const catalogIds = new Set(getModels("openai").map((m) => m.id));
    expect(catalogIds.has(result.model)).toBe(true);
  });

  it("resolves model: 'default' for anthropic returns a Claude model from catalog", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "anthropic" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("anthropic");
    expect(result.model).toMatch(/^claude-/);
    // Must be a live catalog id.
    expect(getModels("anthropic").find((m) => m.id === result.model)).toBeDefined();
  });

  it("resolves model: 'default' for xai (catalog-driven)", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "xai" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("xai");
    const catalogIds = new Set(getModels("xai").map((m) => m.id));
    expect(catalogIds.has(result.model)).toBe(true);
  });

  it("resolves provider 'default' to models.defaultProvider, then catalog-derives model", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "", defaultProvider: "google" },
    );
    expect(result.provider).toBe("google");
    expect(getModels("google").find((m) => m.id === result.model)).toBeDefined();
  });

  it("falls back to first catalog model id for unknown (custom YAML) provider", () => {
    // Unknown provider has no pi-ai catalog -> resolveOperationDefaults({}) returns
    // {}, getModels returns []. Throws because no candidate exists.
    expect(() =>
      resolveAgentModel(
        { model: "default", provider: "unknown-provider" },
        { defaultModel: "", defaultProvider: "" },
      ),
    ).toThrow(/No models found for provider/);
  });

  it("explicit models.defaultModel takes priority over catalog heuristic", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "openai" },
      { defaultModel: "custom-model", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "custom-model", provider: "openai" });
  });

  it("passes through non-'default' values unchanged (explicit per-agent wins over everything)", () => {
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

  it("catalog heuristic with empty model defaultModel for openrouter provider returns an OpenRouter model (not Anthropic)", () => {
    // Phase 2 bugfix regression guard: when an operator picks
    // `provider: openrouter` with `model: default`, the resolved model must
    // be an OpenRouter id, not a Claude id.
    const result = resolveAgentModel(
      { model: "default", provider: "openrouter" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("openrouter");
    expect(result.model).not.toMatch(/^claude-/);
    expect(getModels("openrouter").find((m) => m.id === result.model)).toBeDefined();
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
// Phase 7 plan 08 (B5 + W3 + W6): OAuth credential store wiring
// ---------------------------------------------------------------------------

describe("setupSingleAgent OAuth wiring (Phase 7 plan 08)", () => {
  const source = readFileSync(join(__dirname, "setup-agents.ts"), "utf-8");

  it("invokes createAuthProvider({ oauth: ... }) — closes RESEARCH §4 landmine #1 (unwired-OAuth gap)", () => {
    // RESEARCH §4 landmine #1: createAuthProvider was exported by @comis/agent
    // but never called by the daemon, so refreshed OAuth tokens lived only in
    // the in-memory cache and silently disappeared on restart. Plan 08 adds
    // the FIRST daemon-side call.
    expect(source).toContain("createAuthProvider({");
    expect(source).toMatch(/createAuthProvider\(\s*{[\s\S]*?oauth:\s*{/);
  });

  it("uses safePath (NOT path.join) for all newly-added path constructions (W3 fix)", () => {
    // W3: AGENTS.md §2.2 ESLint security rule forbids path.join in new code.
    // The pre-existing setup-agents.ts source body still uses path.{resolve,
    // dirname, join} via the imports up top for unrelated paths (skills
    // discovery), but the NEW Phase 7 OAuth wiring must use safePath only.
    expect(source).not.toMatch(/path\.join\(/);
    expect(source).not.toMatch(/path\.resolve\(/);
    // The OAuth wiring's dataDir construction must use safePath.
    const phase7Section = source.slice(
      source.indexOf("Phase 7 plan 08"),
      source.indexOf("createAuthProvider({"),
    );
    expect(phase7Section).toContain("safePath(");
  });

  it("selects encrypted-mode adapter via selectOAuthCredentialStore branch", () => {
    // Daemon side: only the call site lives here now (Phase 8 plan 01 moved
    // the helper definition to @comis/agent per RESEARCH override 4).
    expect(source).toContain("selectOAuthCredentialStore({");
    // Encrypted branch lives inside selectOAuthCredentialStore (helper) — pulls
    // both secretsCrypto + secretsDb through deps. Read the helper from its
    // new home in @comis/agent.
    const selectorSource = readFileSync(
      join(__dirname, "..", "..", "..", "agent", "src", "model", "oauth-credential-store-selector.ts"),
      "utf-8",
    );
    const helperBody = selectorSource.slice(
      selectorSource.indexOf("export function selectOAuthCredentialStore"),
    );
    expect(helperBody).toContain('storage === "encrypted"');
    expect(helperBody).toContain("encryptedFactory(secretsDb, secretsCrypto)");
    expect(helperBody).toContain("fileFactory({ dataDir })");
  });
});

describe("selectOAuthCredentialStore (Phase 7 plan 08 — B5 + W6)", () => {
  /** Mock OAuthCredentialStorePort returned by injected factories. */
  function makeMockPort(): OAuthCredentialStorePort {
    return {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      has: vi.fn(),
    } as unknown as OAuthCredentialStorePort;
  }

  it("file mode: invokes createOAuthCredentialStoreFile with { dataDir }", () => {
    const fileMock = vi.fn(() => makeMockPort());
    const encryptedMock = vi.fn(() => makeMockPort());
    const port = selectOAuthCredentialStore({
      storage: "file",
      dataDir: "/tmp/comis-test-w3",
      factories: {
        file: fileMock as unknown as typeof import("@comis/agent").createOAuthCredentialStoreFile,
        encrypted: encryptedMock as unknown as typeof import("@comis/memory").createOAuthProfileStoreEncrypted,
      },
    });
    expect(port).toBeDefined();
    expect(fileMock).toHaveBeenCalledTimes(1);
    expect(fileMock).toHaveBeenCalledWith({ dataDir: "/tmp/comis-test-w3" });
    expect(encryptedMock).not.toHaveBeenCalled();
  });

  it("encrypted mode: passes the SAME db handle (W6 — no dual-handle) and shares secretsCrypto", () => {
    const fileMock = vi.fn(() => makeMockPort());
    const encryptedMock = vi.fn(() => makeMockPort());
    // Use sentinel object identities so we can assert reference-equality.
    const sentinelDb = { __sentinel: "shared-db" } as unknown as Database.Database;
    const sentinelCrypto = { __sentinel: "crypto" } as unknown as SecretsCrypto;
    const port = selectOAuthCredentialStore({
      storage: "encrypted",
      dataDir: "/tmp/comis-test-w6",
      secretsCrypto: sentinelCrypto,
      secretsDb: sentinelDb,
      factories: {
        file: fileMock as unknown as typeof import("@comis/agent").createOAuthCredentialStoreFile,
        encrypted: encryptedMock as unknown as typeof import("@comis/memory").createOAuthProfileStoreEncrypted,
      },
    });
    expect(port).toBeDefined();
    expect(encryptedMock).toHaveBeenCalledTimes(1);
    // CRITICAL W6 assertion: the EXACT db reference passed in is the EXACT
    // db reference handed to the encrypted factory — proves shared-handle,
    // not a freshly-opened one.
    expect(encryptedMock).toHaveBeenCalledWith(sentinelDb, sentinelCrypto);
    expect(fileMock).not.toHaveBeenCalled();
  });

  it("encrypted mode + missing secretsCrypto: throws Error mentioning SECRETS_MASTER_KEY", () => {
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-crypto",
        secretsCrypto: undefined,
        secretsDb: { __sentinel: "db" } as unknown as Database.Database,
      }),
    ).toThrow(/SECRETS_MASTER_KEY/);
  });

  it("encrypted mode + missing secretsDb: throws Error mentioning SECRETS_MASTER_KEY (BOTH fields are required together)", () => {
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-db",
        secretsCrypto: { __sentinel: "crypto" } as unknown as SecretsCrypto,
        secretsDb: undefined,
      }),
    ).toThrow(/SECRETS_MASTER_KEY/);
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
