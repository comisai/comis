# Testing Patterns

**Analysis Date:** 2026-04-17

## Test Framework

**Runner:**
- Vitest 4.0.0 (workspace test runner across all packages)
- Per-package config: `packages/*/vitest.config.ts` with `include: ["src/**/*.test.ts"]`
- Integration test config: `test/vitest.config.ts` with aliases to `dist/` packages

**Assertion Library:**
- Vitest expect API (compatible with Jest)
- Type-safe assertions with full IntelliSense

**Run Commands:**
```bash
pnpm test                       # Run all unit tests (Vitest workspace)
cd packages/core && pnpm test   # Run tests for one package
pnpm test:integration           # Run all integration tests (sequential, max concurrency 1)
pnpm test:integration:mock      # Integration tests with TEST_PROVIDER_MODE=mock
pnpm test:orchestrate           # Full E2E: run all E2E suites + log validation + JSON report
pnpm test:cleanup               # Clean up test artifacts (temp DBs, logs)
```

## Test File Organization

**Location:**
- Unit tests: Co-located with source (`src/component.ts` alongside `src/component.test.ts`)
- Integration tests: Centralized in `test/integration/` directory
- Test support utilities: `test/support/` (daemon harness, event awaiter, mocking helpers)

**Naming:**
- Unit test files: `{source-name}.test.ts` (e.g., `context.test.ts`, `secret-manager.test.ts`)
- Integration test files: `{feature}-{phase}.test.ts` (e.g., `full-system-multiagent.test.ts`, `approval-gate-e2e.test.ts`)

**Per-Package Config Structure:**
```
packages/core/
├── vitest.config.ts          # { test: { include: ["src/**/*.test.ts"] } }
├── src/
│   ├── context.ts
│   ├── context.test.ts        # Co-located test file
│   └── secret-manager.ts
│       └── secret-manager.test.ts
└── tsconfig.json              # Strict mode, isolatedModules: true
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("SecretManager", () => {
  const testEnv = { TEST_KEY: "test-value", API_TOKEN: "secret" };
  
  function makeManager() {
    return createSecretManager(testEnv);
  }

  describe("get()", () => {
    it("returns value when key exists", () => {
      const manager = makeManager();
      expect(manager.get("TEST_KEY")).toBe("test-value");
    });

    it("returns undefined when key does not exist", () => {
      const manager = makeManager();
      expect(manager.get("NONEXISTENT")).toBeUndefined();
    });
  });

  describe("nested requirement", () => {
    it("throws with key name in message when key does not exist", () => {
      const manager = createSecretManager({ A: "val-a" });
      expect(() => manager.require("MISSING")).toThrow("MISSING");
    });
  });
});
```

**Patterns:**
- `describe()` blocks organize tests by component or feature
- Nested `describe()` for grouped test families (e.g., `describe("get()")`, `describe("require()")`)
- Helper functions within test file: `makeManager()`, `makeDeps()` for creating test fixtures
- `beforeEach()` for setup/teardown within test blocks
- No global test setup within unit test files (keep setup local)

## Mocking

**Framework:** Vitest `vi` module

**Import Pattern:**
```typescript
// Mocks MUST be defined BEFORE the import of the module being tested
const mockAdapter = {
  channelType: "discord",
  start: vi.fn(),
  stop: vi.fn(),
};

vi.mock("./discord-adapter.js", () => ({
  createDiscordAdapter: vi.fn(() => mockAdapter),
}));

// AFTER mocks, import the code under test
import { createDiscordPlugin } from "./discord-plugin.js";
```

**Mocking Pattern:**
```typescript
// Create mock object with vi.fn() for methods that will be called
const mockAdapter = {
  channelType: "discord",
  start: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  stop: vi.fn(),
  sendMessage: vi.fn(),
};

// Setup return values in test
mockAdapter.start.mockResolvedValue({ ok: true, value: undefined });

// Assert call behavior
expect(mockAdapter.start).toHaveBeenCalled();
expect(mockAdapter.start).toHaveBeenCalledWith(expectedArgs);

// Clear mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});
```

**What to Mock:**
- External adapters and integrations (Discord, Telegram, database connections)
- File system operations (read, write, delete)
- Time-dependent functions (use vi.useFakeTimers() for scheduled tasks)
- HTTP requests (when not testing HTTP layer directly)

**What NOT to Mock:**
- Core domain logic (errors, Result types, validation)
- Event bus and async context propagation (test real propagation)
- Factory functions (test return types)
- Zod schema validation (test actual validation behavior)

## Fixtures and Factories

**Test Data Pattern:**
```typescript
function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    sessionKey: "tenant-1:user-1:chan-1",
    traceId: randomUUID(),
    startedAt: Date.now(),
    trustLevel: "user",
    ...overrides,
  };
}

// Usage in tests:
const ctx = makeContext();
const customCtx = makeContext({ tenantId: "custom" });
```

**Location:**
- Helper factories defined within test file (if used only there)
- Shared test utilities in `test/support/` (e.g., `mock-logger.ts`, `daemon-harness.ts`)

**Logger Mock Utility** (`test/support/mock-logger.ts`):
```typescript
export function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    audit: vi.fn(),
  };
}

// Usage:
const logger = createMockLogger();
const plugin = createDiscordPlugin({ botToken: "token", logger });
```

**Event Awaiter Utility** (`test/support/event-awaiter.ts`):
```typescript
const awaiter = createEventAwaiter(bus);
const event = await awaiter.waitFor("session:created", { timeoutMs: 5000 });
const allEvents = await awaiter.waitForAll("agent:tick", 3);
const sequence = await awaiter.waitForSequence(["agent:start", "agent:step", "agent:complete"]);
await awaiter.dispose();
```

## Coverage

**Requirements:**
- No enforced minimum coverage target (pragmatic approach)
- Coverage tracking available but not gated

**View Coverage:**
```bash
pnpm vitest run --coverage
```

## Test Types

**Unit Tests:**
- Scope: Individual functions and modules in isolation
- Approach: Fast, focused on business logic, use mocks for external dependencies
- Location: `packages/*/src/**/*.test.ts`
- Example: `secret-manager.test.ts` testing get(), has(), require() methods in isolation

**Integration Tests:**
- Scope: Multiple subsystems working together (agent execution, daemon startup, event propagation)
- Approach: Real daemon instance, real event bus, sequential execution to avoid port conflicts
- Location: `test/integration/**/*.test.ts`
- Configuration: `test/vitest.config.ts` with `pool: "forks"`, `maxConcurrency: 1`, `retry: 1`
- Timeouts: `testTimeout: 60_000`, `hookTimeout: 60_000`, `teardownTimeout: 30_000`

**E2E Tests:**
- Scope: Full system workflows (multi-agent execution, RAG, approval gates)
- Approach: Real daemon, real LLM calls (gated on provider availability)
- Provider gating: Use `describe.skipIf(condition)` to skip tests when API keys unavailable
- Graceful skip: Wrap LLM calls in try/catch with `isAuthError()` to skip on auth failures

**Global Setup:**
- Location: `test/support/global-setup.ts`
- Runs once per test suite startup
- Purpose: Database cleanup, environment validation

## Async Testing Patterns

**Pattern — awaiting promises:**
```typescript
it("context propagates through async/await", async () => {
  const ctx = makeContext();
  const result = await runWithContext(ctx, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return getContext();
  });
  expect(result).toEqual(ctx);
});
```

**Pattern — Promise.all for concurrent tests:**
```typescript
it("concurrent contexts maintain isolation", async () => {
  const ctx1 = makeContext({ tenantId: "A" });
  const ctx2 = makeContext({ tenantId: "B" });
  
  const [result1, result2] = await Promise.all([
    runWithContext(ctx1, async () => getContext().tenantId),
    runWithContext(ctx2, async () => getContext().tenantId),
  ]);
  
  expect(result1).toBe("A");
  expect(result2).toBe("B");
});
```

**Pattern — waiting for events in integration tests:**
```typescript
const awaiter = createEventAwaiter(bus);

const [sessionCreated] = await Promise.all([
  awaiter.waitFor("session:created"),
  executeAgentRequest(), // Triggers event
]);

expect(sessionCreated.sessionKey).toBeDefined();
awaiter.dispose();
```

## Error Testing

**Pattern — testing error conditions:**
```typescript
it("throws with key name in message when key does not exist", () => {
  const manager = createSecretManager({ A: "val-a" });
  expect(() => manager.require("MISSING")).toThrow("MISSING");
});

it("error message does NOT enumerate available key names", () => {
  const manager = createSecretManager({ A: "val-a", B: "val-b" });
  try {
    manager.require("MISSING");
    expect.fail("should have thrown");
  } catch (e) {
    const msg = (e as Error).message;
    expect(msg).toContain("MISSING");
    expect(msg).not.toContain("A");
    expect(msg).not.toContain("B");
  }
});
```

**Pattern — Result type testing:**
```typescript
it("returns ok result when successful", () => {
  const result = plugin.register({});
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(expectedValue);
  }
});

it("returns error result when failed", () => {
  const result = plugin.register({});
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("expected message");
  }
});
```

## Zod Schema Testing

**Pattern — Schema validation:**
```typescript
it("validates correct context", () => {
  const result = RequestContextSchema.safeParse({
    userId: "user-1",
    sessionKey: "default:user-1:chan-1",
    traceId: randomUUID(),
    startedAt: Date.now(),
  });
  expect(result.success).toBe(true);
});

it("rejects missing required fields", () => {
  const result = RequestContextSchema.safeParse({ tenantId: "t1" });
  expect(result.success).toBe(false);
});

it("rejects unknown fields (strict mode)", () => {
  const result = RequestContextSchema.safeParse({
    tenantId: "t1",
    userId: "u1",
    sessionKey: "t1:u1:c1",
    traceId: randomUUID(),
    startedAt: Date.now(),
    extraField: "should-fail",
  });
  expect(result.success).toBe(false);
});
```

## Integration Test Patterns

**Daemon Harness Setup:**
```typescript
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";

let handle: TestDaemonHandle;

beforeAll(async () => {
  handle = await startTestDaemon({ configPath: CONFIG_PATH });
}, 120_000); // 2-minute timeout for daemon startup

afterAll(async () => {
  if (handle) {
    try {
      await handle.cleanup();
    } catch (err) {
      // Gracefully handle daemon exit errors
    }
  }
}, 30_000);
```

**WebSocket Communication:**
```typescript
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";

let ws: WebSocket | undefined;
try {
  ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  const response = await sendJsonRpc(
    ws,
    "agent.execute",
    { agentId: "alpha", message: "test" },
    1, // Request ID
    { timeoutMs: RPC_LLM_MS }
  );
  expect(response.result).toBeDefined();
} finally {
  ws?.close();
}
```

**Provider Gating:**
```typescript
import { getProviderEnv, hasProvider, isAuthError } from "../support/provider-env.js";

const env = getProviderEnv();
const hasOpenAIKey = hasProvider(env, "OPENAI_API_KEY");

describe.skipIf(!hasOpenAIKey)("LLM-dependent tests", () => {
  it("executes with LLM", async () => {
    try {
      const response = await executeWithLLM();
      expect(response).toBeDefined();
    } catch (err) {
      if (isAuthError(err)) {
        // Skip gracefully on auth failures
        throw new Error("LLM auth failed, skipping");
      }
      throw err;
    }
  });
});
```

## Common Test Utilities

**`test/support/mock-logger.ts`:**
- `createMockLogger()` — Returns object with info, debug, warn, error, audit methods (vi.fn() mocks)

**`test/support/event-awaiter.ts`:**
- `createEventAwaiter(bus)` — Returns awaiter with waitFor, waitForAll, waitForSequence, collectDuring, dispose
- `waitFor(eventName, options?)` — Wait for single event, resolves with payload
- `waitForAll(eventName, count)` — Wait for N events, resolves with array
- `waitForSequence(events)` — Wait for events in order

**`test/support/daemon-harness.ts`:**
- `startTestDaemon(options)` — Start real daemon, returns TestDaemonHandle with gatewayUrl, authToken
- `TestDaemonHandle.cleanup()` — Gracefully shut down daemon
- Port management: Extracts from config, waits for port availability

**`test/support/provider-env.ts`:**
- `getProviderEnv()` — Read provider API keys from environment
- `hasProvider(env, key)` — Check if specific provider is available
- `hasAnyProvider(env, group)` — Check if any provider in group (e.g., PROVIDER_GROUPS.llm)
- `isAuthError(err)` — Detect auth failures for graceful skipping

**`test/support/timeouts.ts`:**
- `RPC_LLM_MS` — Timeout for LLM-based RPC calls
- `RPC_FAST_MS` — Timeout for fast RPC calls
- `EVENT_WAIT_MS` — Timeout for event waiting
- `ASYNC_SETTLE_MS` — Timeout for async operations to settle

## Test Characteristics

**Sequential Execution:**
- Integration tests run with `maxConcurrency: 1`, `pool: "forks"` (daemon binds real ports)
- Prevents port conflicts, ensures clean state between tests
- Retry: `retry: 1` (one retry on failure)

**Cleanup:**
- `beforeAll` removes stale test databases to prevent cross-run contamination
- Example: `unlinkSync(resolve(process.env["HOME"] ?? "", ".comis/test-memory-multiagent.db"))`
- `afterAll` calls `handle.cleanup()` to shut down daemon gracefully

**Error Handling:**
- Try/catch around daemon cleanup to handle expected exit codes gracefully
- LLM calls wrapped in try/catch with `isAuthError()` for graceful skipping
- Timeouts on all async operations (integration test config specifies 60s default)

---

*Testing analysis: 2026-04-17*
