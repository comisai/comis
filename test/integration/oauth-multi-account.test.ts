// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 9 SC#2 evidence: two-agent end-to-end test asserting per-agent
 * OAuth profile preference is honored at every LLM call.
 *
 * R3 + R8 SC#2 evidence: end-to-end test that two agents configured with
 * different `oauthProfiles` preferences each invoke the mock LLM endpoint
 * with their respective profile's access token in the Authorization header.
 *
 * Test inventory (5 tests):
 *   1. SC#2 main: agentA -> TOKEN_A, agentB -> TOKEN_B (Bearer header + chatgpt-account-id header).
 *   2. JWT cross-check: decoded `chatgpt_account_id` claim per request matches the configured profile.
 *   3a. R7 round-trip - closure-mutation contract (low-level invariant): mutate the shared
 *       agents map directly, assert next call uses the new profile.
 *   3b. R7 round-trip - END-TO-END via actual `agents.update` RPC handler. Drives the real
 *       production hot-update path through `createAgentHandlers` + `handlers["agents.update"]`,
 *       asserting that Plan 06's reference-replacement at agent-handlers.ts:386 is observed by
 *       Plan 04's Option B closure on the very next outbound LLM call. THIS IS THE FALSIFIABLE
 *       PROOF OF SC#4 closure-stability.
 *   4. PROFILE_NOT_FOUND propagation: configured profileId not in store -> resolve throws
 *       before any LLM call is dispatched.
 *
 * Architecture note (revision iter 1):
 *   The test simulates the executor's pre-LLM-call dispatch hook + the wrapped
 *   pi-ai outbound call by:
 *     (a) Building an OAuthTokenManager with `getAgentOauthProfiles: () => agents[agentId]?.oauthProfiles`.
 *         The closure dereferences the SHARED agents map (mirroring daemon's container.config.agents
 *         pattern at daemon.ts:594/634).
 *     (b) Calling `resolveProviderApiKey(...)` — the same helper PiExecutor.execute() uses at
 *         line 450 of pi-executor.ts to pre-resolve the OAuth token AND set the runtime API key.
 *     (c) Issuing a direct fetch to https://chatgpt.com/backend-api/codex/responses with
 *         the same headers pi-ai's `streamOpenAICodexResponses` sets per RESEARCH F-01
 *         (Authorization: Bearer <token>, chatgpt-account-id: <accountId from JWT>). The
 *         fetch-spy redirects this URL to the in-process mock, which captures the headers.
 *         This faithful inline reproduction avoids cross-package importing pi-ai (which
 *         resolves only inside @comis/agent's node_modules, not at the test root) while
 *         exercising every byte of the production header surface.
 *   This shape exercises the FULL falsifiable contract:
 *     - Plan 04 Option B closure observes the shared map.
 *     - Plan 06's `agents.update` reference-replacement (line 386) propagates to that closure.
 *     - The resulting outbound HTTP call carries the resolved OAuth token in `Bearer ${token}`.
 *
 * Note: test/vitest.config.ts already enforces maxConcurrency: 1 + pool: "forks" + retry: 1,
 * so a per-file `describe.sequential` annotation is REDUNDANT (RESEARCH override 3). Don't add it.
 *
 * Run with: `pnpm build && pnpm vitest run --config test/vitest.config.ts test/integration/oauth-multi-account.test.ts`.
 *
 * @module
 */

import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  TypedEventBus,
  createSecretManager,
  type OAuthCredentialStorePort,
  type OAuthProfile,
  type PerAgentConfig,
} from "@comis/core";
import {
  createOAuthCredentialStoreFile,
  createOAuthTokenManager,
  createAuthStorageAdapter,
  resolveProviderApiKey,
  type OAuthTokenManager,
} from "@comis/agent";
import {
  createAgentHandlers,
  type AgentHandlerDeps,
} from "@comis/daemon";
import {
  createMockOAuthServer,
  type MockOAuthServer,
} from "../support/mock-oauth-server.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "openai-codex";
const CODEX_URL_PREFIX = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_URL_PREFIX = "https://auth.openai.com/oauth/token";

// ---------------------------------------------------------------------------
// Fixture lifecycle (mirrors oauth-login.test.ts:36-92)
// ---------------------------------------------------------------------------

let mockServer: MockOAuthServer;
let mockBaseUrl: string;
let originalFetch: typeof globalThis.fetch;
let tmpDir: string;
let store: OAuthCredentialStorePort;

beforeAll(async () => {
  mockServer = createMockOAuthServer();
  const { baseUrl } = await mockServer.start();
  mockBaseUrl = baseUrl;
  originalFetch = globalThis.fetch;
});

afterAll(async () => {
  if (mockServer) await mockServer.stop();
  if (originalFetch) globalThis.fetch = originalFetch;
});

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "comis-09-multi-account-"));
  store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      // Phase 9 D-13 + RESEARCH F-01: redirect BOTH the OAuth refresh
      // endpoint AND the Codex LLM endpoint to the in-process mock.
      if (url.startsWith(TOKEN_URL_PREFIX)) {
        return originalFetch(`${mockBaseUrl}/oauth/token`, init);
      }
      if (url.startsWith(CODEX_URL_PREFIX)) {
        return originalFetch(`${mockBaseUrl}/codex/responses`, init);
      }
      return originalFetch(input as RequestInfo, init);
    },
  );
  mockServer.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a realistic-shape JWT inline. The mock-oauth-server fixture defines
 * `makeRealisticJwt` but does not export it; this is a deliberate ~10-LoC
 * duplication kept consistent with the fixture's payload shape (Phase 9
 * PATTERNS.md "do NOT add describe.sequential — fixture pattern is fine to
 * inline").
 */
function makeJwt(payload: Record<string, unknown>): string {
  const headerB64 = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const fullPayload = {
    iss: "https://auth.openai.com/",
    aud: "https://api.openai.com/v1",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  };
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString(
    "base64url",
  );
  return `${headerB64}.${payloadB64}.fake-signature-not-validated-by-test`;
}

/**
 * Pre-seed an OAuthProfile into the credential store. Returns the access
 * token string so tests can assert against the captured Authorization
 * header verbatim.
 */
async function seedProfile(
  credentialStore: OAuthCredentialStorePort,
  profileId: string,
  email: string,
  accountId: string,
): Promise<string> {
  const access = makeJwt({
    "https://api.openai.com/profile": { email },
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
  const profile: OAuthProfile = {
    provider: PROVIDER_ID,
    profileId,
    access,
    refresh: `REFRESH_${accountId}`,
    // Far-future expiry — pi-ai's getOAuthApiKey only refreshes when expired,
    // so the seeded JWT is returned verbatim and lands in the captured
    // Authorization header. This is the contract that makes the assertions
    // `expect(calls[0].authorization).toBe(\`Bearer ${TOKEN_A}\`)` pass.
    expires: Date.now() + 60 * 60_000,
    accountId,
    email,
    version: 1,
  };
  const setResult = await credentialStore.set(profileId, profile);
  if (!setResult.ok) {
    throw new Error(`seed failed: ${setResult.error.message}`);
  }
  return access;
}

/**
 * Build an OAuthTokenManager wired with a closure that dereferences the
 * shared `agents` map for `agentId`'s oauthProfiles (mirrors daemon's
 * container.config.agents pattern at daemon.ts:594/634, plus Plan 04
 * Option B closure-stability fix).
 */
function buildOAuthManager(
  credentialStore: OAuthCredentialStorePort,
  agents: Record<string, PerAgentConfig>,
  agentId: string,
): OAuthTokenManager {
  return createOAuthTokenManager({
    secretManager: createSecretManager({}),
    eventBus: new TypedEventBus(),
    credentialStore,
    logger: makeSilentLogger(),
    dataDir: tmpDir,
    keyPrefix: "OAUTH_",
    // Phase 9 D-05/Option B: closure dereferences the shared agents map
    // handle on every getApiKey() call. Map identity stays stable;
    // only the value at agentId changes via reference-replacement.
    getAgentOauthProfiles: () => agents?.[agentId]?.oauthProfiles,
  });
}

/** Minimal Pino-shaped logger that drops every log call. */
function makeSilentLogger(): Parameters<typeof createOAuthTokenManager>[0]["logger"] {
  const noop = () => undefined;
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger as unknown as Parameters<typeof createOAuthTokenManager>[0]["logger"];
}

/**
 * Build a minimal PerAgentConfig with the given oauthProfiles. The Zod
 * schema fills in defaults for everything else — the integration test
 * only cares about provider + oauthProfiles.
 */
function makeAgent(profileId: string): PerAgentConfig {
  // Use `as PerAgentConfig` cast: the Zod schema requires many defaulted
  // fields that we don't need to override. This object's identity is what
  // matters (closure observes the value at the agent key).
  return {
    name: "test-agent",
    provider: PROVIDER_ID,
    model: "gpt-5-codex",
    oauthProfiles: { [PROVIDER_ID]: profileId },
  } as unknown as PerAgentConfig;
}

/**
 * Drive the full executor pre-LLM-call dispatch hook + outbound HTTP request,
 * mirroring exactly what `PiExecutor.execute()` does at pi-executor.ts:432-454
 * + the wrapped pi-ai AgentSession's outbound call. Returns once the SSE stream
 * has terminated (mock LLM returns response.completed immediately).
 *
 * Why this shape (instead of full PiExecutor.execute):
 *   - PiExecutor has 50+ deps and runs full agent loops; constructing it for
 *     an integration test would dwarf the test surface.
 *   - The relevant production path is exactly:
 *       1. resolveProviderApiKey(...) — pre-hook at line 450 of pi-executor.ts.
 *       2. Pi-ai's outbound LLM call reading the apiKey from setRuntimeApiKey
 *          (or via the explicit `apiKey` option, equivalent runtime priority).
 *   - Both steps are exercised here verbatim. Plan 04's closure + Plan 06's
 *     reference-replacement contracts are observed end-to-end. The captured
 *     Authorization header is the falsifiable assertion target.
 */
async function executeOAuthLLMCall(
  agentId: string,
  agents: Record<string, PerAgentConfig>,
  manager: OAuthTokenManager,
): Promise<void> {
  const authStorage = createAuthStorageAdapter({
    secretManager: createSecretManager({}),
  });
  // Step 1: same call as pi-executor.ts:450 (the executor's pre-execute hook).
  // Side effect: writes the resolved OAuth token into authStorage's runtime
  // override map AND returns it for direct use below.
  const apiKey = await resolveProviderApiKey(agents[agentId]!.provider, {
    authStorage,
    oauthManager: manager,
    agentConfig: agents[agentId],
  });

  // Step 2: outbound LLM HTTP call — a faithful reproduction of what
  // pi-ai's `streamOpenAICodexResponses` does at provider/openai-codex-responses.js:124
  // (`fetch(resolveCodexUrl(model.baseUrl), { method: "POST", headers: sseHeaders, body, ... })`).
  //
  // Why an inline reproduction instead of importing pi-ai directly:
  //   - `@mariozechner/pi-ai/openai-codex-responses` is declared as a
  //     dependency of `@comis/agent` (and other workspace packages), but
  //     the integration test's runtime resolution lives at the repo root
  //     where pi-ai isn't hoisted. Adding pi-ai to the root devDependencies
  //     would broaden the dependency graph for an integration concern.
  //   - The integration value is verifying Comis's OAuth resolution chain:
  //     Plan 04's closure observes the shared agents map, Plan 06's
  //     reference-replacement is observed by that closure, the resolved
  //     token lands in the outbound HTTP request as `Bearer <token>`.
  //     None of these require pi-ai's request-body assembly machinery —
  //     just the outbound headers, which we mirror exactly per RESEARCH F-01:
  //       Authorization: Bearer <token>
  //       chatgpt-account-id: <accountId from JWT>
  //       OpenAI-Beta: responses=experimental
  //       accept: text/event-stream
  //       content-type: application/json
  //
  // The chatgpt-account-id is computed identically to pi-ai's
  // `extractAccountId` (provider/openai-codex-responses.js:724-738):
  // base64url-decode the JWT payload and read
  // `payload["https://api.openai.com/auth"].chatgpt_account_id`.
  const accountId = extractAccountIdFromJwt(apiKey);
  const codexUrl = "https://chatgpt.com/backend-api/codex/responses";
  const response = await fetch(codexUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
      originator: "pi",
      "User-Agent": "pi (test)",
    },
    body: JSON.stringify({
      model: agents[agentId]!.model,
      stream: true,
      input: [{ role: "user", content: "hello" }],
    }),
  });
  // Drain the SSE response so the connection completes cleanly.
  // The mock returns `response.completed` immediately.
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Mirror of pi-ai's `extractAccountId` (provider/openai-codex-responses.js:724-738):
 * base64url-decode the JWT payload, read the chatgpt_account_id claim.
 * Throws if the token is malformed — matches pi-ai's strict-throw contract
 * so a malformed test fixture surfaces immediately rather than silently
 * sending an empty `chatgpt-account-id` header.
 */
function extractAccountIdFromJwt(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Invalid JWT format");
  }
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Failed to extract accountId from token");
  }
  return accountId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 9 multi-account profile selection (R3 + R8 SC#2)", () => {
  it("Test 1: routes each agent's LLM call to its configured oauthProfile (Bearer header + chatgpt-account-id header)", async () => {
    const TOKEN_A = await seedProfile(
      store,
      "openai-codex:user-a@example.com",
      "user-a@example.com",
      "ACC_A",
    );
    const TOKEN_B = await seedProfile(
      store,
      "openai-codex:user-b@example.com",
      "user-b@example.com",
      "ACC_B",
    );

    const agents: Record<string, PerAgentConfig> = {
      "agent-a": makeAgent("openai-codex:user-a@example.com"),
      "agent-b": makeAgent("openai-codex:user-b@example.com"),
    };

    const managerA = buildOAuthManager(store, agents, "agent-a");
    const managerB = buildOAuthManager(store, agents, "agent-b");

    // Sequential execution per CONTEXT D-16. The vitest config enforces
    // maxConcurrency: 1 across files; within this file, we serialize
    // explicitly to make per-call assertions order-independent of any
    // future test infrastructure change.
    await executeOAuthLLMCall("agent-a", agents, managerA);
    await executeOAuthLLMCall("agent-b", agents, managerB);

    const calls = mockServer.getLlmRequests();

    // Risk-6 sanity: assert calls were captured BEFORE asserting specific
    // header values. If the WebSocket transport had silently bypassed the
    // fetch-spy, calls.length would be 0 and this would fail with a clear
    // diagnostic instead of a misleading "Bearer X did not equal Bearer Y".
    expect(calls.length).toBeGreaterThanOrEqual(2);

    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(calls[1]!.authorization).toBe(`Bearer ${TOKEN_B}`);

    // chatgpt-account-id header (sent by pi-ai per RESEARCH F-01 — pi-ai
    // extracts this from the JWT's `chatgpt_account_id` claim and sets
    // it as a separate header).
    expect(calls[0]!.accountId).toBe("ACC_A");
    expect(calls[1]!.accountId).toBe("ACC_B");
  });

  it("Test 2: decoded JWT chatgpt_account_id claim per request matches the configured profile", async () => {
    await seedProfile(
      store,
      "openai-codex:user-a@example.com",
      "user-a@example.com",
      "ACC_A",
    );
    await seedProfile(
      store,
      "openai-codex:user-b@example.com",
      "user-b@example.com",
      "ACC_B",
    );

    const agents: Record<string, PerAgentConfig> = {
      "agent-a": makeAgent("openai-codex:user-a@example.com"),
      "agent-b": makeAgent("openai-codex:user-b@example.com"),
    };
    const managerA = buildOAuthManager(store, agents, "agent-a");
    const managerB = buildOAuthManager(store, agents, "agent-b");

    await executeOAuthLLMCall("agent-a", agents, managerA);
    await executeOAuthLLMCall("agent-b", agents, managerB);

    const calls = mockServer.getLlmRequests();
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // Decode JWT payload from each captured Authorization header.
    function extractAccountId(authHeader: string): string {
      const token = authHeader.replace(/^Bearer\s+/, "");
      const parts = token.split(".");
      if (parts.length !== 3 || !parts[1]) {
        throw new Error(`Malformed JWT in Authorization header: ${authHeader}`);
      }
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString(),
      );
      const accountId = payload?.["https://api.openai.com/auth"]
        ?.chatgpt_account_id;
      return typeof accountId === "string" ? accountId : "";
    }

    expect(extractAccountId(calls[0]!.authorization)).toBe("ACC_A");
    expect(extractAccountId(calls[1]!.authorization)).toBe("ACC_B");
  });

  it("Test 3a (R7 round-trip - closure-mutation contract): direct in-place oauthProfiles mutation updates the next call's profile", async () => {
    // Low-level test: documents the closure-stability contract at the
    // OAuthTokenManager getter boundary. Does NOT drive the actual RPC
    // handler. Test 3b below is the production-path round-trip.

    const TOKEN_A = await seedProfile(
      store,
      "openai-codex:user-a@example.com",
      "user-a@example.com",
      "ACC_A",
    );
    const TOKEN_B = await seedProfile(
      store,
      "openai-codex:user-b@example.com",
      "user-b@example.com",
      "ACC_B",
    );

    const agents: Record<string, PerAgentConfig> = {
      "agent-b": makeAgent("openai-codex:user-a@example.com"),
    };
    const manager = buildOAuthManager(store, agents, "agent-b");

    // First call: should use TOKEN_A.
    await executeOAuthLLMCall("agent-b", agents, manager);
    let calls = mockServer.getLlmRequests();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN_A}`);

    // Direct closure-captured-object mutation (NOT via RPC; documents
    // low-level contract). Reassigning the SAME agent key with a new
    // PerAgentConfig is the contract; in-place edit of the existing
    // object would also work but reference-replacement is what the
    // production agents.update RPC does (Test 3b verifies that).
    agents["agent-b"] = makeAgent("openai-codex:user-b@example.com");

    mockServer.reset();
    await executeOAuthLLMCall("agent-b", agents, manager);
    calls = mockServer.getLlmRequests();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN_B}`);
  });

  it("Test 3b (R7 round-trip - END-TO-END via actual agents.update RPC handler; falsifiable proof of SC#4 closure-stability per revision iter 1)", async () => {
    // Production-path test: drives the actual `handlers["agents.update"]`
    // RPC, which executes the reference-replacement at agent-handlers.ts:386
    // (`deps.agents[agentId] = parsedConfig`). The OAuthTokenManager's
    // getAgentOauthProfiles closure dereferences the SAME shared `agents`
    // map handle on every getApiKey call (Plan 04 Option B). This test is
    // the only evidence that the entire production hot-update path works
    // correctly.

    const TOKEN_A = await seedProfile(
      store,
      "openai-codex:user-a@example.com",
      "user-a@example.com",
      "ACC_A",
    );
    const TOKEN_B = await seedProfile(
      store,
      "openai-codex:user-b@example.com",
      "user-b@example.com",
      "ACC_B",
    );

    // Shared agents map — the SAME reference used by:
    //   1. The OAuthTokenManager's getAgentOauthProfiles closure (via buildOAuthManager).
    //   2. The agent-handlers' deps.agents (via createAgentHandlers).
    // This mirrors the daemon's daemon.ts:594/634 pattern where deps.agents
    // IS container.config.agents.
    const agentBId = "agent-b";
    const agents: Record<string, PerAgentConfig> = {
      [agentBId]: makeAgent("openai-codex:user-a@example.com"),
    };
    const manager = buildOAuthManager(store, agents, agentBId);

    // Build the actual agents.update RPC handler with the SAME agents map
    // + the same OAuthCredentialStore (the daemon-side has() check uses
    // this). The defaultAgentId is set to a sentinel that does NOT match
    // agentBId — the agent-handlers.ts agents.delete path forbids deleting
    // the default; we won't exercise that path so the value is irrelevant.
    const handlerDeps: AgentHandlerDeps = {
      agents,
      defaultAgentId: "default",
      suspendedAgents: new Set<string>(),
      oauthCredentialStore: store,
      // No persistDeps — memory-only mode (the integration test only cares
      // about the in-memory map mutation; YAML persistence is exercised by
      // Plan 06's unit tests, not this integration).
      // No hotAdd/hotRemove — agents.update doesn't invoke those.
    };
    const handlers = createAgentHandlers(handlerDeps);

    // First call: should use TOKEN_A.
    await executeOAuthLLMCall(agentBId, agents, manager);
    let calls = mockServer.getLlmRequests();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN_A}`);

    // Capture the original reference at agent-b BEFORE the update so we
    // can assert reference-replacement (NOT in-place mutation) below.
    const originalAgentBRef = agents[agentBId];

    // Drive the ACTUAL agents.update RPC handler. This executes the
    // reference-replacement at agent-handlers.ts:386 (`deps.agents[agentId] = parsedConfig`).
    // The shared `agents` map sees the new value at the agent-b key.
    const updateResult = await handlers["agents.update"]!({
      _trustLevel: "admin",
      agentId: agentBId,
      config: {
        oauthProfiles: { "openai-codex": "openai-codex:user-b@example.com" },
      },
    });
    expect(updateResult).toBeDefined();

    // Pin the reference-replacement contract: agents["agent-b"] is a NEW
    // object after update. (Plan 06 Test 5 also pins this at the unit-test
    // level; this integration test pins it for end-to-end belt-and-suspenders.)
    expect(agents[agentBId]).not.toBe(originalAgentBRef);
    expect(agents[agentBId]!.oauthProfiles).toEqual({
      "openai-codex": "openai-codex:user-b@example.com",
    });

    // Second call: the OAuthTokenManager's getAgentOauthProfiles closure
    // dereferences `agents?.[agentBId]?.oauthProfiles` — observes the
    // new value. Resolver chain tier (a) returns the new profile's token
    // (TOKEN_B). Falsifiable: if Plan 04's Option B closure ever regresses
    // to capturing the local agentConfig variable, this test fails because
    // the closure-captured reference would still be the OLD object
    // (originalAgentBRef), not the NEW one in the map.
    mockServer.reset();
    await executeOAuthLLMCall(agentBId, agents, manager);
    calls = mockServer.getLlmRequests();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN_B}`);
  });

  it("Test 4: PROFILE_NOT_FOUND propagates as fatal error when configured profile is missing from store", async () => {
    // Seed only profile A; agent points at NON-existent profile B.
    await seedProfile(
      store,
      "openai-codex:user-a@example.com",
      "user-a@example.com",
      "ACC_A",
    );

    const agents: Record<string, PerAgentConfig> = {
      "agent-c": makeAgent("openai-codex:user-b@example.com"),
    };
    const manager = buildOAuthManager(store, agents, "agent-c");

    // resolveProviderApiKey throws when the OAuth manager returns an
    // err(OAuthError) per Plan 04 D-02. The throw propagates up to the
    // caller; the mock LLM endpoint MUST NOT receive a request because
    // the resolver short-circuited before pi-ai dispatched.
    await expect(
      executeOAuthLLMCall("agent-c", agents, manager),
    ).rejects.toThrow(/not found in store/);

    const calls = mockServer.getLlmRequests();
    expect(calls.length).toBe(0);
  });
});
