// SPDX-License-Identifier: Apache-2.0
/**
 * Mock-driven tests for `comis auth` Phase 9 R4/R5/R6 changes.
 *
 * Lives in a separate file from `auth.test.ts` because the success-path
 * coverage requires module-level `vi.mock(...)` of `@comis/agent` and
 * `@comis/core` so the login flow does not touch the real OAuth runner.
 *
 * Coverage:
 *   R4 — `auth login --profile <id>` valid override:
 *        * the resulting `OAuthProfile` is written to the store at
 *          `profileId === <user-supplied-id>` (NOT the JWT-derived id);
 *        * email/accountId/displayName remain JWT-derived;
 *        * the success line includes both the email AND the user-supplied
 *          profile ID.
 *   R5 — `auth list --provider <id>` filter (table contents + empty state).
 *   R6 — `auth status --provider <id>` filter (per-group output + empty state).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// -----------------------------------------------------------------------------
// Mocks must be declared BEFORE the SUT import so vitest applies them.
// -----------------------------------------------------------------------------

// Mock @comis/agent — replace the OAuth login runner with a deterministic
// fixture that returns a fixed JWT-derived profile. Other named exports are
// kept as `vi.fn()` stubs because they are referenced at import time by
// `auth.ts`.
vi.mock("@comis/agent", () => ({
  loginOpenAICodexOAuth: vi.fn(async () => ({
    ok: true,
    value: {
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 60 * 60_000, // 1h
      accountId: "acct-123",
      email: "user_a@example.com",
      displayName: "User A",
      profileId: "openai-codex:user_a@example.com",
    },
  })),
  selectOAuthCredentialStore: vi.fn(),
  isRemoteEnvironment: vi.fn(() => false),
  redactEmailForLog: vi.fn((e?: string) => e ?? null),
}));

// Mock @comis/core — keep the real `validateProfileId` (we want its real
// validation behavior driving R4 mismatch / malformed assertions) but stub
// the config-loading helpers so `openOAuthStoreFromConfig` short-circuits to
// the file adapter without touching `~/.comis/config.yaml`.
vi.mock("@comis/core", async () => {
  const actual = await vi.importActual<typeof import("@comis/core")>(
    "@comis/core",
  );
  return {
    ...actual,
    loadConfigFile: vi.fn(() => ({ ok: false, error: new Error("no config") })),
    validateConfig: vi.fn(),
    safePath: vi.fn((...parts: string[]) => parts.join("/")),
  };
});

// Mock @comis/infra — `createLogger` returns a no-op logger. Other exports
// are stubs (auth.ts only uses createLogger).
vi.mock("@comis/infra", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the `open` package so attempted browser launches are no-ops.
vi.mock("open", () => ({ default: vi.fn() }));

// Mock the clack adapter so login does not block on interactive prompts.
vi.mock("../wizard/clack-adapter.js", () => ({
  createClackAdapter: () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    select: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
  }),
}));

// -----------------------------------------------------------------------------
// SUT imports (after mocks).
// -----------------------------------------------------------------------------

const { registerAuthCommand } = await import("./auth.js");
const agent = await import("@comis/agent");

// Reference to the in-memory store the tests will inject. Each test seeds
// this via `selectOAuthCredentialStore` mock return.
type StoreState = Map<string, unknown>;

interface FakeStore {
  state: StoreState;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  has: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function createFakeStore(initial: Map<string, unknown> = new Map()): FakeStore {
  const state = initial;
  return {
    state,
    set: vi.fn(async (id: string, p: unknown) => {
      state.set(id, p);
      return { ok: true, value: undefined };
    }),
    get: vi.fn(async (id: string) => ({ ok: true, value: state.get(id) })),
    has: vi.fn(async (id: string) => ({ ok: true, value: state.has(id) })),
    delete: vi.fn(async (id: string) => {
      const had = state.has(id);
      state.delete(id);
      return { ok: true, value: had };
    }),
    list: vi.fn(async () => ({ ok: true, value: Array.from(state.values()) })),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  registerAuthCommand(program);
  return program;
}

function spyExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
}

function spyConsole(): {
  log: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
} {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("auth login --profile override (R4)", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = createFakeStore();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      store as unknown as ReturnType<typeof agent.selectOAuthCredentialStore>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the profile under the user-supplied ID, preserving JWT identity fields", async () => {
    const program = buildProgram();
    const exitSpy = spyExit();
    const console_ = spyConsole();

    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--provider",
      "openai-codex",
      "--profile",
      "openai-codex:work-alias",
      "--local",
    ]);

    // store.set was called with the user-supplied profile ID, NOT the
    // JWT-derived `openai-codex:user_a@example.com`.
    expect(store.set).toHaveBeenCalledTimes(1);
    const [setKey, setProfile] = store.set.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(setKey).toBe("openai-codex:work-alias");
    expect(setProfile.profileId).toBe("openai-codex:work-alias");
    // Identity fields still come from the JWT/runner result.
    expect(setProfile.email).toBe("user_a@example.com");
    expect(setProfile.accountId).toBe("acct-123");
    expect(setProfile.displayName).toBe("User A");
    // Tokens preserved.
    expect(setProfile.access).toBe("test-access-token");
    expect(setProfile.refresh).toBe("test-refresh-token");

    // Stdout success line includes BOTH the email and the user-supplied id.
    const out = joinCalls(console_.log);
    expect(out).toContain("user_a@example.com");
    expect(out).toContain("openai-codex:work-alias");

    exitSpy.mockRestore();
    console_.log.mockRestore();
    console_.error.mockRestore();
  });

  it("uses the JWT-derived profile ID when --profile is absent (Phase 8 path unchanged)", async () => {
    const program = buildProgram();
    const exitSpy = spyExit();
    const console_ = spyConsole();

    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--provider",
      "openai-codex",
      "--local",
    ]);

    expect(store.set).toHaveBeenCalledTimes(1);
    const [setKey, setProfile] = store.set.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(setKey).toBe("openai-codex:user_a@example.com");
    expect(setProfile.profileId).toBe("openai-codex:user_a@example.com");

    exitSpy.mockRestore();
    console_.log.mockRestore();
    console_.error.mockRestore();
  });
});

describe("auth list --provider filter (R5)", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = createFakeStore(
      new Map<string, unknown>([
        [
          "openai-codex:a@example.com",
          {
            provider: "openai-codex",
            profileId: "openai-codex:a@example.com",
            access: "x",
            refresh: "y",
            expires: Date.now() + 60_000,
            email: "a@example.com",
            version: 1,
          },
        ],
        [
          "openai-codex:b@example.com",
          {
            provider: "openai-codex",
            profileId: "openai-codex:b@example.com",
            access: "x",
            refresh: "y",
            expires: Date.now() + 60_000,
            email: "b@example.com",
            version: 1,
          },
        ],
        [
          "anthropic:c@example.com",
          {
            provider: "anthropic",
            profileId: "anthropic:c@example.com",
            access: "x",
            refresh: "y",
            expires: Date.now() + 60_000,
            email: "c@example.com",
            version: 1,
          },
        ],
      ]),
    );
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      store as unknown as ReturnType<typeof agent.selectOAuthCredentialStore>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters the table to only the named provider's profiles", async () => {
    const program = buildProgram();
    const console_ = spyConsole();

    await program.parseAsync([
      "node",
      "test",
      "auth",
      "list",
      "--provider",
      "openai-codex",
    ]);

    const out = joinCalls(console_.log);
    expect(out).toContain("openai-codex:a@example.com");
    expect(out).toContain("openai-codex:b@example.com");
    expect(out).not.toContain("anthropic:c@example.com");

    console_.log.mockRestore();
    console_.error.mockRestore();
  });

  it("prints provider-specific empty-state when filter matches nothing", async () => {
    const program = buildProgram();
    const console_ = spyConsole();

    await program.parseAsync([
      "node",
      "test",
      "auth",
      "list",
      "--provider",
      "missing",
    ]);

    const out = joinCalls(console_.log);
    expect(out).toContain('No OAuth profiles stored for provider "missing".');

    console_.log.mockRestore();
    console_.error.mockRestore();
  });

  it("shows all profiles when --provider is absent (Phase 8 behavior)", async () => {
    const program = buildProgram();
    const console_ = spyConsole();

    await program.parseAsync(["node", "test", "auth", "list"]);

    const out = joinCalls(console_.log);
    expect(out).toContain("openai-codex:a@example.com");
    expect(out).toContain("openai-codex:b@example.com");
    expect(out).toContain("anthropic:c@example.com");

    console_.log.mockRestore();
    console_.error.mockRestore();
  });
});

describe("auth status --provider filter (R6)", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = createFakeStore(
      new Map<string, unknown>([
        [
          "openai-codex:a@example.com",
          {
            provider: "openai-codex",
            profileId: "openai-codex:a@example.com",
            access: "x",
            refresh: "y",
            expires: Date.now() + 60_000,
            email: "a@example.com",
            version: 1,
          },
        ],
        [
          "anthropic:c@example.com",
          {
            provider: "anthropic",
            profileId: "anthropic:c@example.com",
            access: "x",
            refresh: "y",
            expires: Date.now() + 60_000,
            email: "c@example.com",
            version: 1,
          },
        ],
      ]),
    );
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      store as unknown as ReturnType<typeof agent.selectOAuthCredentialStore>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints only the filtered provider's group", async () => {
    const program = buildProgram();
    const console_ = spyConsole();

    await program.parseAsync([
      "node",
      "test",
      "auth",
      "status",
      "--provider",
      "openai-codex",
    ]);

    const out = joinCalls(console_.log);
    expect(out).toContain("openai-codex");
    expect(out).toContain("openai-codex:a@example.com");
    expect(out).not.toContain("anthropic:c@example.com");

    console_.log.mockRestore();
    console_.error.mockRestore();
  });

  it("prints the per-provider empty-state line when filter matches nothing", async () => {
    const program = buildProgram();
    const console_ = spyConsole();

    await program.parseAsync([
      "node",
      "test",
      "auth",
      "status",
      "--provider",
      "missing",
    ]);

    const out = joinCalls(console_.log);
    expect(out).toContain('No OAuth profiles stored for provider "missing".');

    console_.log.mockRestore();
    console_.error.mockRestore();
  });

  it("prints all groups when --provider is absent (Phase 8 behavior)", async () => {
    const program = buildProgram();
    const console_ = spyConsole();

    await program.parseAsync(["node", "test", "auth", "status"]);

    const out = joinCalls(console_.log);
    expect(out).toContain("openai-codex");
    expect(out).toContain("anthropic");
    expect(out).toContain("openai-codex:a@example.com");
    expect(out).toContain("anthropic:c@example.com");

    console_.log.mockRestore();
    console_.error.mockRestore();
  });
});
