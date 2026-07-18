// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the setup-agents runtime leaf hosting `setupSingleAgent` —
 * inspects its source body for skillRegistry + OutputGuard + canary token
 * + OAuth wiring + safePath discipline.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupSingleAgent } from "./setup-agents-runtime.js";
// selectOAuthCredentialStore's consuming call-site lives in
// setup-agents-runtime.ts (and setup-agents-registry.ts), so its tests stay
// co-located with the runtime leaf.
import {
  selectOAuthCredentialStore,
  type OAuthCredentialStorePort,
} from "@comis/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readRuntimeSource(): string {
  return readFileSync(join(__dirname, "setup-agents-runtime.ts"), "utf-8");
}

describe("setup-agents-runtime wiring", () => {
  it("passes skillRegistry to createPiExecutor deps (regression guard)", () => {
    const source = readRuntimeSource();

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

  it("passes a live connected MCP instruction resolver to createPiExecutor", () => {
    const source = readRuntimeSource();
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    expect(depsStart).toBeGreaterThan(-1);
    expect(depsEnd).toBeGreaterThan(depsStart);

    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("getMcpServerInstructions:");
    expect(depsBlock).toContain("deps.mcpClientManager.getAllConnections()");
    expect(depsBlock).toContain('connection.status === "connected"');
    expect(depsBlock).toContain("connection.instructions?.trim()");
    expect(depsBlock).toContain("connection.instructionHash");
    expect(depsBlock).toContain("serverId: connection.name");
    expect(depsBlock).toContain('trust: "external" as const');
  });

  it("passes the composed workspace policy port to each executor", () => {
    const source = readRuntimeSource();
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("workspacePolicyPort:");
    expect(depsBlock).toContain("container.workspacePolicyPort");
  });
});

// ---------------------------------------------------------------------------
// Learned-skill surface seam wiring
//
// The getPromptSkillsXml seam must delegate to renderLearnedSkillsXml (the
// merge-INTO-the-seam keystone so the per-session freeze captures the merged
// listing) reading the per-agent surface cache, NOT the bare
// skillRegistry.getSnapshot().prompt. The cache is built via
// wireAgentLearnedSkillSurface gated on learningSkills.enabled × the master cost
// switch, so a default-off agent does ZERO surface work (no list()/rmSync). It
// registers into the shared learnedSkillSurfaceRegistry so the promote/demote
// loop can re-refresh the agent's surface.
// ---------------------------------------------------------------------------

describe("setupSingleAgent learned-skill surface wiring", () => {
  const source = readRuntimeSource();

  it("delegates the getPromptSkillsXml seam to renderLearnedSkillsXml (not the bare snapshot prompt)", () => {
    // The old seam returned skillRegistry.getSnapshot().prompt directly — that
    // bare form must be GONE from the deps block (it bypassed the merge).
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    const depsBlock = source.slice(depsStart, depsEnd);

    expect(depsBlock).toMatch(/getPromptSkillsXml:\s*\(\)\s*=>\s*renderLearnedSkillsXml\(/);
    expect(depsBlock).not.toContain("getPromptSkillsXml: () => skillRegistry.getSnapshot().prompt");
    // The seam reads the per-agent cache's `.current` snapshot (not a fresh async list()).
    expect(depsBlock).toContain("learnedSkills: learnedSurface.current");
  });

  it("builds the surface via wireAgentLearnedSkillSurface, gated on learning.enabled × cost + registered for re-refresh", () => {
    const fnStart = source.indexOf("export async function setupSingleAgent(");
    const fnBody = source.slice(fnStart);
    // The cache is built via the gated helper (NOT the ungated createLearnedSkillSurfaceCache).
    expect(fnBody).toContain("wireAgentLearnedSkillSurface({");
    expect(fnBody).not.toContain("createLearnedSkillSurfaceCache({"); // ungated form is gone
    const callStart = fnBody.indexOf("wireAgentLearnedSkillSurface({");
    const callWindow = fnBody.slice(callStart, callStart + 420);
    // The gate: the collapsed learning.enabled AND the master cost switch.
    expect(callWindow).toContain("effectiveConfig.learning?.enabled === true");
    expect(callWindow).toContain("memory?.enabled !== false");
    // Threaded store + resolved (tenant, agent) scope.
    expect(callWindow).toContain("learnedSkillStore: deps.learnedSkillStore");
    expect(callWindow).toContain("tenantId: container.config.tenantId");
    expect(callWindow).toContain("workspaceDir: dir");
    // Registered into the shared registry for the promote/demote re-refresh.
    expect(callWindow).toContain("registry: deps.learnedSkillSurfaceRegistry");
  });

  it("imports renderLearnedSkillsXml + wireAgentLearnedSkillSurface from the surface modules", () => {
    expect(source).toMatch(/import\s*\{[^}]*renderLearnedSkillsXml[^}]*\}\s*from\s*"\.\/learned-skill-surface\.js"/s);
    expect(source).toMatch(
      /import\s*\{[^}]*wireAgentLearnedSkillSurface[^}]*\}\s*from\s*"\.\/learned-skill-surface-registry\.js"/s,
    );
  });
});

describe("setupSingleAgent OutputGuard wiring", () => {
  it("passes outputGuard and canaryToken to createPiExecutor deps (OGUARD regression guard)", () => {
    const source = readRuntimeSource();

    // Verify OutputGuard and canary token are created before the deps block.
    // The guard must be constructed WITH the daemon's known secrets so bare
    // (prefix-less) secret values are redacted by exact match.
    expect(source).toContain("createOutputGuard({ knownSecrets: gatewayTokenSecrets })");
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
    const source = readRuntimeSource();
    // Post-split the helper lives in setup-agents-tooling.ts; setup-agents-runtime.ts
    // imports it from that leaf and references it (and CANARY_SECRET) here.
    expect(source).toContain("deriveCanaryFallback");
    expect(source).toContain("CANARY_SECRET");
  });
});

describe("setup-agents-runtime skills directory creation", () => {
  it("creates agent skills directory before skill registry init (SKILL-DIR regression guard)", () => {
    const source = readRuntimeSource();

    // agentSkillsDir must be created before createSkillRegistry is called
    const mkdirPos = source.indexOf("mkdirSync(agentSkillsDir");
    const registryPos = source.indexOf("const skillRegistry = createSkillRegistry(");
    expect(mkdirPos).toBeGreaterThan(-1);
    expect(registryPos).toBeGreaterThan(mkdirPos);
  });
});

// ---------------------------------------------------------------------------
// OAuth credential store wiring
// ---------------------------------------------------------------------------

describe("setupSingleAgent OAuth wiring", () => {
  const source = readRuntimeSource();
  // The OAuth auth-provider construction was extracted to setup-agents-oauth.ts
  // (file-size split); the runtime file now calls wireAuthProvider(...).
  const oauthSource = readFileSync(
    join(__dirname, "setup-agents-oauth.ts"),
    "utf-8",
  );

  it("invokes createAuthProvider({ oauth: ... }) — closes the unwired-OAuth gap", () => {
    // createAuthProvider was previously exported by @comis/agent but never
    // called by the daemon, so refreshed OAuth tokens lived only in the
    // in-memory cache and silently disappeared on restart. The daemon-side
    // call (now in the extracted wireAuthProvider helper) closes that gap.
    expect(oauthSource).toContain("createAuthProvider({");
    expect(oauthSource).toMatch(/createAuthProvider\(\s*{[\s\S]*?oauth:\s*{/);
    // The runtime file delegates to the extracted helper.
    expect(source).toContain("wireAuthProvider({");
  });

  it("uses safePath (NOT path.join) for all newly-added path constructions", () => {
    // AGENTS.md ESLint security rule forbids path.join in new code.
    // The pre-existing setup-agents.ts source body still uses path.{resolve,
    // dirname, join} via the imports up top for unrelated paths (skills
    // discovery), but the OAuth wiring must use safePath only.
    expect(source).not.toMatch(/path\.join\(/);
    expect(source).not.toMatch(/path\.resolve\(/);
    expect(oauthSource).not.toMatch(/path\.join\(/);
    expect(oauthSource).not.toMatch(/path\.resolve\(/);
    // The OAuth wiring's path construction (now in the helper) must use safePath.
    expect(oauthSource).toContain("safePath(");
    // The runtime file's remaining dataDir construction also uses safePath.
    const oauthSection = source.slice(
      source.indexOf("FIRST daemon-side OAuth wiring"),
      source.indexOf("wireAuthProvider({"),
    );
    expect(oauthSection).toContain("safePath(");
  });

  it("selects encrypted-mode adapter via selectOAuthCredentialStore branch", () => {
    // The daemon constructs the encrypted store inline (it owns secretsDb +
    // secretsCrypto) and injects it into the selector via `encryptedStore`.
    // The selector body itself does not import @comis/memory; it just returns
    // the injected port for encrypted mode. selectOAuthCredentialStore is
    // invoked from setup-agents-registry.ts; createOAuthProfileStoreEncrypted
    // is also value-imported there (it constructs the encrypted store inline).
    const registrySource = readFileSync(
      join(__dirname, "setup-agents-registry.ts"),
      "utf-8",
    );
    expect(registrySource).toContain("selectOAuthCredentialStore({");
    expect(registrySource).toContain('import { createOAuthProfileStoreEncrypted } from "@comis/memory"');
    expect(registrySource).toContain("createOAuthProfileStoreEncrypted(deps.secretsDb, deps.secretsCrypto)");
    expect(registrySource).toMatch(/selectOAuthCredentialStore\(\{[\s\S]*?encryptedStore[\s\S]*?\}\)/);
    // Selector body lives in @comis/core and returns the injected port
    // without touching any memory factory.
    const selectorSource = readFileSync(
      join(__dirname, "..", "..", "..", "..", "core", "src", "oauth", "oauth-credential-store-selector.ts"),
      "utf-8",
    );
    const helperBody = selectorSource.slice(
      selectorSource.indexOf("export function selectOAuthCredentialStore"),
    );
    expect(helperBody).toContain('storage === "encrypted"');
    expect(helperBody).toContain("return encryptedStore");
    // File factory consumes the daemon-injected FileLockPort alongside dataDir.
    expect(helperBody).toContain("fileFactory({ dataDir, fileLock })");
    // Negative assertion: the selector source must NOT import @comis/memory.
    expect(selectorSource).not.toContain('from "@comis/memory"');
  });
});

describe("selectOAuthCredentialStore", () => {
  /** Mock OAuthCredentialStorePort returned by the file factory or injected directly. */
  function makeMockPort(): OAuthCredentialStorePort {
    return {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      has: vi.fn(),
    } as unknown as OAuthCredentialStorePort;
  }

  /**
   * Minimal FileLockPort stub. `fileLock` is required on
   * SelectOAuthCredentialStoreInput; the file branch forwards it into the
   * file factory, while the encrypted branch ignores it.
   */
  function makeFileLockStub(): import("@comis/core").FileLockPort {
    return {
      acquire: vi.fn(),
      release: vi.fn(),
      withLock: vi.fn(),
      isLocked: vi.fn(async () => false),
      cleanupStaleLocks: vi.fn(async () => 0),
    };
  }

  it("file mode: invokes createOAuthCredentialStoreFile with { dataDir, fileLock }; ignores encryptedStore", () => {
    const fileMock = vi.fn(() => makeMockPort());
    const sentinelEncrypted = makeMockPort();
    const fileLock = makeFileLockStub();
    const port = selectOAuthCredentialStore({
      storage: "file",
      dataDir: "/tmp/comis-test-w3",
      fileLock,
      // Even when an encryptedStore is supplied, file mode must NOT use it —
      // the file branch unconditionally delegates to the file factory.
      encryptedStore: sentinelEncrypted,
      factories: {
        file: fileMock as unknown as typeof import("@comis/core").createOAuthCredentialStoreFile,
      },
    });
    expect(port).toBeDefined();
    expect(port).not.toBe(sentinelEncrypted);
    expect(fileMock).toHaveBeenCalledTimes(1);
    expect(fileMock).toHaveBeenCalledWith({ dataDir: "/tmp/comis-test-w3", fileLock });
  });

  it("encrypted mode: returns the injected encryptedStore by reference (no internal factory call)", () => {
    const fileMock = vi.fn(() => makeMockPort());
    // Sentinel identity proves the selector returns the EXACT injected port
    // (daemon owns construction; selector is a pass-through for encrypted mode).
    const sentinelEncrypted = makeMockPort();
    const port = selectOAuthCredentialStore({
      storage: "encrypted",
      dataDir: "/tmp/comis-test-w6",
      fileLock: makeFileLockStub(),
      encryptedStore: sentinelEncrypted,
      factories: {
        file: fileMock as unknown as typeof import("@comis/core").createOAuthCredentialStoreFile,
      },
    });
    expect(port).toBe(sentinelEncrypted);
    expect(fileMock).not.toHaveBeenCalled();
  });

  it("encrypted mode + missing encryptedStore: throws Error pointing daemon composition at the inject point", () => {
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-port",
        fileLock: makeFileLockStub(),
        encryptedStore: undefined,
      }),
    ).toThrow(/no encrypted store was injected/);
    // The error message must name setup-agents.ts (the daemon-side construction
    // site) AND createOAuthProfileStoreEncrypted (the factory the daemon calls).
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-port",
        fileLock: makeFileLockStub(),
      }),
    ).toThrow(/setup-agents\.ts/);
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-port",
        fileLock: makeFileLockStub(),
      }),
    ).toThrow(/createOAuthProfileStoreEncrypted/);
  });
});

// ---------------------------------------------------------------------------
// setupSingleAgent structural parity tests
// ---------------------------------------------------------------------------

describe("setupSingleAgent structural parity", () => {
  const source = readRuntimeSource();

  it("setupSingleAgent is exported and is an async function", () => {
    expect(typeof setupSingleAgent).toBe("function");
    // Verify it is declared as async in source
    expect(source).toContain("export async function setupSingleAgent(");
  });

  it("setupSingleAgent validates config with PerAgentConfigSchema", () => {
    // Find setupSingleAgent function body
    const fnStart = source.indexOf("export async function setupSingleAgent(");
    expect(fnStart).toBeGreaterThan(-1);

    // The function body should contain PerAgentConfigSchema.parse
    const fnBody = source.slice(fnStart);
    expect(fnBody).toContain("PerAgentConfigSchema.parse(");
  });
});

// ---------------------------------------------------------------------------
// Recall-trace config threading
//
// The recall-trace recorder + sanitization pipeline are built and proven in
// isolation, but the daemon never threaded diagnostics.recallTrace into the
// executor — so buildRecallTrace always received cfg=undefined → returned null
// → ZERO recall traces were written even with diagnostics.recallTrace.enabled:
// true. The fix mirrors the EXISTING cacheTraceConfig wiring: a parallel
// `recallTraceConfig: container.config.diagnostics?.recallTrace` entry inside
// the createPiExecutor deps object.
// ---------------------------------------------------------------------------

describe("setupSingleAgent recall-trace config wiring", () => {
  const source = readRuntimeSource();

  it("threads container.config.diagnostics.recallTrace into createPiExecutor deps as recallTraceConfig", () => {
    // Production-wiring regression guard. Before this wiring existed, the
    // createPiExecutor deps block carried cacheTraceConfig but NOT
    // recallTraceConfig, so the recall trace was structurally unreachable
    // from operator YAML. The assertion is scoped to the deps block (not the
    // whole file) so a stray comment elsewhere cannot satisfy it.
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    expect(depsStart).toBeGreaterThan(-1);
    expect(depsEnd).toBeGreaterThan(depsStart);

    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("recallTraceConfig");
    expect(depsBlock).toContain("container.config.diagnostics");
    // The field reads diagnostics.recallTrace specifically (mirrors the
    // sibling cacheTraceConfig line which reads diagnostics.cacheTrace).
    expect(depsBlock).toMatch(
      /recallTraceConfig:\s*container\.config\.diagnostics\??\.recallTrace/,
    );
  });

  it("keeps the cacheTraceConfig wiring intact alongside recallTraceConfig (no regression)", () => {
    // The two diagnostics threads are siblings; the new wiring must not
    // displace the existing cache-trace thread.
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("cacheTraceConfig");
    expect(depsBlock).toMatch(
      /cacheTraceConfig:\s*container\.config\.diagnostics\??\.cacheTrace/,
    );
  });
});

describe("setupSingleAgent GBNF compat threading (production wiring guard)", () => {
  const source = readRuntimeSource();

  it("passes getProviderType and getModelCompat resolvers in createPiExecutor deps", () => {
    // Production-wiring regression guard. Before this wiring existed,
    // providers.entries.<key>.models[].comisCompat validated in config but
    // was consumed by NOTHING -- pi-executor's normalizeModelCompat call
    // received only {provider, id}, so the explicit gbnf opt-in and the
    // type:"ollama" auto-detect signal were structurally unreachable from
    // operator YAML. Scoped to the deps block (not the whole file) so a
    // stray mention elsewhere cannot satisfy it.
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    expect(depsStart).toBeGreaterThan(-1);
    expect(depsEnd).toBeGreaterThan(depsStart);

    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("getProviderType:");
    expect(depsBlock).toContain("getModelCompat:");
  });

  it("pins the resolver bodies so the deps keys cannot be wired to stubs", () => {
    // A recurring failure class is built-but-not-wired: a key present
    // but resolving nothing. getProviderType must read the provider entry's
    // declared config `type`; getModelCompat must look the model up in
    // models[] and return its comisCompat.
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    const depsBlock = source.slice(depsStart, depsEnd);

    const gptIdx = depsBlock.indexOf("getProviderType:");
    expect(gptIdx).toBeGreaterThan(-1);
    const gptWindow = depsBlock.slice(gptIdx, gptIdx + 120);
    expect(gptWindow).toContain("?.type");

    const gmcIdx = depsBlock.indexOf("getModelCompat:");
    expect(gmcIdx).toBeGreaterThan(-1);
    const gmcWindow = depsBlock.slice(gmcIdx, gmcIdx + 200);
    expect(gmcWindow).toContain("?.models?.find(");
    expect(gmcWindow).toContain("?.comisCompat");
  });
});

// ---------------------------------------------------------------------------
// Per-agent effective rag.rerank.enabled precedence +
// the modelPresent threading daemon -> registry -> types -> runtime (Pitfall 4).
// ---------------------------------------------------------------------------

describe("setupSingleAgent rerank auto-on precedence", () => {
  const source = readRuntimeSource();
  const typesSource = readFileSync(
    join(__dirname, "setup-agents-types.ts"),
    "utf-8",
  );
  const registrySource = readFileSync(
    join(__dirname, "setup-agents-registry.ts"),
    "utf-8",
  );
  // The composition root threads the SAME modelPresent boolean setup-memory
  // computed; daemon.ts wires it into the setupAgents call.
  const daemonSource = readFileSync(
    join(__dirname, "..", "..", "daemon.ts"),
    "utf-8",
  );

  it("imports resolveEffectiveRerank from ./setup-agents-tooling.js", () => {
    // The pure precedence fn lives beside its sibling resolveAgentModel.
    expect(source).toMatch(
      /import\s*\{[^}]*resolveEffectiveRerank[^}]*\}\s*from\s*"\.\/setup-agents-tooling\.js"/s,
    );
  });

  it("computes effectiveConfig.rag.rerank.enabled via resolveEffectiveRerank (spread preserves siblings)", () => {
    const fnStart = source.indexOf("export async function setupSingleAgent(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart);
    // The rag spread must nest correctly so maxCandidates/minResults/timeoutMs
    // survive and only `enabled` is overridden by the precedence call.
    expect(fnBody).toContain(
      "rerank: { ...agentConfig.rag.rerank, enabled: resolveEffectiveRerank(",
    );
  });

  it("feeds resolveEffectiveRerank the GENUINE raw tri-state signal, not the zod-defaulted parse", () => {
    // The precedence MUST read the RAW (pre-Zod-default) rerank value.
    // The parsed agentConfig.rag.rerank.enabled is ALWAYS a concrete boolean
    // (it carries a `.default()` — default-ON), so reading it would
    // erase the unset signal and make the zero-download auto-on precedence impossible.
    // The raw value comes from the explicit `rawRerankEnabled` arg (hot-add)
    // else the daemon-wide map on the container (boot path). The OLD broken code read
    // `rawAgentConfig.rag?.rerank?.enabled` (a misnomer — that object was already parsed);
    // assert that dead pattern is GONE.
    const fnStart = source.indexOf("export async function setupSingleAgent(");
    const fnBody = source.slice(fnStart);
    expect(fnBody).not.toContain("rawAgentConfig.rag?.rerank?.enabled");
    // The resolved raw value (rawRerank) is what feeds resolveEffectiveRerank.
    const callStart = fnBody.indexOf("enabled: resolveEffectiveRerank(");
    const callSlice = fnBody.slice(callStart, callStart + 80);
    expect(callSlice).toContain("rawRerank");
    expect(callSlice).toContain("deps.rerankerModelPresent");
    // rawRerank resolves from the explicit arg first, then the container raw map.
    expect(fnBody).toContain("rawRerankEnabled !== undefined");
    expect(fnBody).toContain("container.rawAgentRerankEnabled?.get(agentId)");
  });

  it("threads the raw rerank signal from the boot loop and hot-add into setupSingleAgent (one source)", () => {
    // The boot loop passes container.rawAgentRerankEnabled.get(agentId) as the 4th arg.
    expect(registrySource).toContain("container.rawAgentRerankEnabled?.get(agentId)");
    // The build gate (setup-memory) reads the SAME raw map, so the two gates can't desync.
    const memorySource = readFileSync(
      join(__dirname, "..", "setup-memory.ts"),
      "utf-8",
    );
    expect(memorySource).toContain("container.rawAgentRerankEnabled");
  });

  it("still writes the effective config back to container.config.agents[agentId] (downstream contract)", () => {
    // The precedence must flow through the EXISTING write-back, not mutate
    // agentConfig in place — downstream consumers read container.config.agents.
    expect(source).toContain("container.config.agents[agentId] = effectiveConfig");
  });

  it("threads rerankerModelPresent through SingleAgentDeps, AgentsArgs, the build literal, and daemon.ts (Pitfall 4: one source)", () => {
    // SingleAgentDeps interface carries it (beside rerankerPort).
    expect(typesSource).toContain("rerankerModelPresent");
    // AgentsArgs carries it AND the SingleAgentDeps build literal forwards it.
    expect(registrySource).toContain("rerankerModelPresent");
    expect(registrySource).toContain("rerankerModelPresent: deps.rerankerModelPresent");
    // daemon.ts destructures it off the setupMemory result AND passes it to setupAgents.
    expect(daemonSource).toContain("rerankerModelPresent");
  });
});

// ---------------------------------------------------------------------------
// AuthStorage hot-swap wiring guards
//
// These tests assert the secret-rotation hot-swap subscription is present in
// the wiring source (setup-agents-runtime.ts or setup-agents-registry.ts).
//
// The subscription maps a changed credential name to every affected provider
// and re-syncs each provider from the scoped SecretManager. Re-resolution is
// required so deleting a preferred name can expose a configured alias.
// A non-provider key (e.g. MY_DATABASE_URL) is a no-op.
// ---------------------------------------------------------------------------

describe("AuthStorage secret:changed hot-swap wiring", () => {
  const runtimeSrc = readFileSync(
    join(__dirname, "setup-agents-runtime.ts"),
    "utf-8",
  );
  const registrySrc = readFileSync(
    join(__dirname, "setup-agents-registry.ts"),
    "utf-8",
  );

  it("secret:changed subscription is wired in setup-agents wiring source", () => {
    // Asserts that the production source contains the hot-swap subscription:
    // one of these sources subscribes to secret:changed.
    const runtimeContains = runtimeSrc.includes('"secret:changed"');
    const registryContains = registrySrc.includes('"secret:changed"');
    expect(runtimeContains || registryContains).toBe(true);
  });

  it("setup-agents wiring re-syncs provider credentials after secret changes", () => {
    const runtimeContains = runtimeSrc.includes("secret:changed") && runtimeSrc.includes("syncCredentialsForSecretChange");
    const registryContains = registrySrc.includes("secret:changed") && registrySrc.includes("syncCredentialsForSecretChange");
    expect(runtimeContains || registryContains).toBe(true);
  });

  it("setup-agents wiring includes custom provider entries in secret refreshes", () => {
    expect(runtimeSrc).toContain("customProviderEntries");
    expect(runtimeSrc).toMatch(
      /syncCredentialsForSecretChange\([\s\S]*customProviderEntries[\s\S]*\)/,
    );
  });
});
