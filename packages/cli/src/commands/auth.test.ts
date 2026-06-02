// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the `comis auth` CLI command tree.
 *
 * Scope: argv parsing + dispatch shape only — full end-to-end behavior
 * (against the mock OAuth server) is covered by the integration test
 * `test/integration/oauth-login.test.ts`.
 *
 * These tests catch commander wiring regressions (e.g., a typo that
 * loses a subcommand, or a missing requiredOption).
 *
 * @module
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Command } from "commander";
import { registerAuthCommand } from "./auth.js";

// loginOpenAICodexOAuth makes real network calls (device-code polling, browser
// OAuth server). Mock it so action-body tests exit:1 immediately instead of
// hanging until the 5s Vitest timeout.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    loginOpenAICodexOAuth: vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "callback_timeout" as const,
        message: "mock: login flow not executed in unit test",
        hint: "",
      },
    })),
  };
});

// Mock rpc-client so encrypted-mode tests can assert callTyped was invoked
// with AuthSetContract without a real daemon connection.
vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  callTyped: vi.fn(async () => ({ profileId: "openai-codex:test@example.com", stored: true })),
}));

// Mock requireDaemonOrExit so encrypted-mode tests can assert it is called
// without requiring a real running daemon.
vi.mock("../util/daemon-required.js", () => ({
  requireDaemonOrExit: vi.fn(async () => undefined),
}));

describe("registerAuthCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  function spyStderr(): ReturnType<typeof vi.spyOn> {
    // The CLI's `error()` helper writes to stderr via console.error.
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  it("registers four subcommands: login, list, logout, status", () => {
    const program = buildProgram();
    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth).toBeDefined();
    if (!auth) return;
    const subcommandNames = auth.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual(["list", "login", "logout", "status"]);
  });

  it("rejects --provider != 'openai-codex' with exit code 2", async () => {
    const program = buildProgram();
    const exitSpy = spyExit();
    spyStderr();
    await expect(
      program.parseAsync(["node", "test", "auth", "login", "--provider", "anthropic"]),
    ).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });

  // `--profile` is validated as an override. Coverage for acceptance /
  // mismatch / malformed cases lives below (and in the dedicated mock-driven
  // file `auth.profile-override.test.ts`).

  it("rejects --profile with malformed value (forbidden character) with exit 2", async () => {
    const program = buildProgram();
    const exitSpy = spyExit();
    const stderr = spyStderr();
    await expect(
      program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--provider",
        "openai-codex",
        "--profile",
        "openai-codex:bad/path",
        "--local",
      ]),
    ).rejects.toThrow("exit:2");
    expect(
      stderr.mock.calls.some((c) =>
        String(c[0]).includes("Invalid --profile value"),
      ),
    ).toBe(true);
    exitSpy.mockRestore();
  });

  it("rejects --profile when provider portion does not match --provider with exit 2", async () => {
    const program = buildProgram();
    const exitSpy = spyExit();
    const stderr = spyStderr();
    await expect(
      program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--provider",
        "openai-codex",
        "--profile",
        "anthropic:user_a@example.com",
        "--local",
      ]),
    ).rejects.toThrow("exit:2");
    expect(
      stderr.mock.calls.some((c) =>
        String(c[0]).includes("provider mismatch"),
      ),
    ).toBe(true);
    exitSpy.mockRestore();
  });

  it("preserves the existing --provider rejection for non-codex providers", async () => {
    const program = buildProgram();
    const exitSpy = spyExit();
    spyStderr();
    await expect(
      program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--provider",
        "anthropic",
      ]),
    ).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });

  it("login subcommand requires --provider", async () => {
    const program = buildProgram();
    // Commander's required-option enforcement triggers process.exit(1) by
    // default. We spy on it so the test can observe the rejection. Some
    // commander versions surface as exit:1 (the default missing-required code);
    // accept either 1 or 2 to be robust to commander minor-version variation.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      program.parseAsync(["node", "test", "auth", "login"]),
    ).rejects.toThrow(/exit:[12]/);
    exitSpy.mockRestore();
  });

  it("logout subcommand requires --profile", async () => {
    const program = buildProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      program.parseAsync(["node", "test", "auth", "logout"]),
    ).rejects.toThrow(/exit:[12]/);
    exitSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // --method device-code flag
  // -------------------------------------------------------------------------

  it("rejects --method device-code with non-codex provider (exit 2)", async () => {
    const program = buildProgram();
    const exitSpy = spyExit();
    const stderr = spyStderr();
    await expect(
      program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--provider",
        "anthropic",
        "--method",
        "device-code",
      ]),
    ).rejects.toThrow("exit:2");
    // The first --provider check fires before --method validation, so we
    // also accept the existing "must be 'openai-codex'" error message.
    // What matters: exit code 2 and stderr written.
    expect(stderr.mock.calls.length).toBeGreaterThan(0);
    exitSpy.mockRestore();
  });

  it("accepts --method device-code with --provider openai-codex (parses without exit 2)", async () => {
    // We don't fully execute the login flow (that requires the OAuth credential
    // store + device-code module + mock OAuth server). Instead, we verify the
    // commander wiring accepts the flag — i.e., commander does not exit before
    // entering the action body. The action body will fail when it tries to
    // read config + open the credential store; we observe that as a different
    // exit code (1, not 2). The key assertion is: NOT exit:2 for the flag itself.
    const program = buildProgram();
    const exitSpy = spyExit();
    spyStderr();
    // The action is async — it will reject with whatever exit code the body
    // hits (could be 1 from store/login error, never 2 from flag parsing).
    await expect(
      program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--provider",
        "openai-codex",
        "--method",
        "device-code",
        "--local",
      ]),
    ).rejects.toThrow(/exit:1/);
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// auth login — mode branching (TDD RED tests — Task 1 of plan 04-03)
//
// These tests assert the encrypted/env/':'-separator behaviors that will be
// implemented in Task 2. They must FAIL before the implementation (RED).
// ---------------------------------------------------------------------------

describe("auth login — mode branching", () => {
  // Import the mocked modules for assertion.
  let callTypedMock: ReturnType<typeof vi.fn>;
  let requireDaemonOrExitMock: ReturnType<typeof vi.fn>;
  let loginOpenAICodexOAuthMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    const rpcClientMod = await import("../client/rpc-client.js");
    const daemonRequiredMod = await import("../util/daemon-required.js");
    const coreMod = await import("@comis/core");

    callTypedMock = rpcClientMod.callTyped as ReturnType<typeof vi.fn>;
    requireDaemonOrExitMock = daemonRequiredMod.requireDaemonOrExit as ReturnType<typeof vi.fn>;
    loginOpenAICodexOAuthMock = coreMod.loginOpenAICodexOAuth as ReturnType<typeof vi.fn>;

    // Default: mocks resolve successfully
    (rpcClientMod.withClient as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (c: unknown) => unknown) => fn({}),
    );
    callTypedMock.mockResolvedValue({ profileId: "openai-codex:test@example.com", stored: true });
    requireDaemonOrExitMock.mockResolvedValue(undefined);
    loginOpenAICodexOAuthMock.mockResolvedValue({
      ok: true as const,
      value: {
        access: "tok-access",
        refresh: "tok-refresh",
        expires: Date.now() + 3_600_000,
        profileId: "openai-codex:test@example.com",
        email: "test@example.com",
        accountId: "acct-123",
        displayName: "Test User",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.COMIS_CONFIG_PATHS;
  });

  function buildProgram(): Command {
    const program = new Command();
    registerAuthCommand(program);
    return program;
  }

  // Test 1: encrypted mode calls callTyped with AuthSetContract (not process.exit(1))
  it("encrypted mode: login calls callTyped (not exit:1 for encrypted)", async () => {
    // Set up a temporary config file for encrypted mode
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-test-"));
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "security:\n  storage: encrypted\n",
    );
    process.env.COMIS_CONFIG_PATHS = configPath;

    const program = buildProgram();
    // encrypted mode should NOT exit:1 (old behavior) — it should call callTyped
    // with AuthSetContract and succeed (or at least not exit with the old "cannot
    // bootstrap" message). The new behavior calls callTyped which we mock to succeed.
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--provider",
      "openai-codex",
      "--local",
    ]);
    expect(callTypedMock).toHaveBeenCalledTimes(1);
    // Verify the first argument (contract) has method "auth.set"
    const firstCallArgs = callTypedMock.mock.calls[0];
    expect(firstCallArgs[1]).toMatchObject({ method: "auth.set" });

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 2: encrypted mode — requireDaemonOrExit is called before the OAuth flow
  it("encrypted mode: requireDaemonOrExit is called before loginOpenAICodexOAuth", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-test-"));
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, "security:\n  storage: encrypted\n");
    process.env.COMIS_CONFIG_PATHS = configPath;

    const callOrder: string[] = [];
    requireDaemonOrExitMock.mockImplementation(async () => {
      callOrder.push("requireDaemonOrExit");
    });
    loginOpenAICodexOAuthMock.mockImplementation(async () => {
      callOrder.push("loginOpenAICodexOAuth");
      return {
        ok: true as const,
        value: {
          access: "tok-access",
          refresh: "tok-refresh",
          expires: Date.now() + 3_600_000,
          profileId: "openai-codex:test@example.com",
          email: "test@example.com",
          accountId: "acct-123",
          displayName: "Test User",
        },
      };
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--provider",
      "openai-codex",
      "--local",
    ]);

    expect(callOrder).toEqual(["requireDaemonOrExit", "loginOpenAICodexOAuth"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 3: env mode exits with process.exit(1) and logs actionable message
  it("env mode: login action exits with exit:1 and 'env mode is read-only' message", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-test-"));
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, "security:\n  storage: env\n");
    process.env.COMIS_CONFIG_PATHS = configPath;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = buildProgram();
    await expect(
      program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--provider",
        "openai-codex",
        "--local",
      ]),
    ).rejects.toThrow("exit:1");

    // Should print an actionable "env" + "read-only" message
    const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(allStderr).toMatch(/env/i);
    expect(allStderr).toMatch(/read-only/i);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 4: COMIS_CONFIG_PATHS ':' separator — loadStorageMode reads first path
  it("':' separator: loadStorageMode uses ':' to split COMIS_CONFIG_PATHS", async () => {
    // Create a config file in encrypted mode at a specific path.
    // Use a ':'-joined path in COMIS_CONFIG_PATHS (e.g., "/tmp/a.yaml:/tmp/b.yaml").
    // loadStorageMode should take the FIRST path (encrypted), not default to file.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-test-"));
    const configPath = path.join(tmpDir, "config.yaml");
    const decoyPath = path.join(tmpDir, "decoy.yaml");
    fs.writeFileSync(configPath, "security:\n  storage: encrypted\n");
    fs.writeFileSync(decoyPath, "security:\n  storage: file\n");

    // Set COMIS_CONFIG_PATHS to "configPath:decoyPath" — if comma-split is used,
    // the entire string would be taken as the path (no comma present), falling
    // back to ~/.comis/config.yaml and returning "file" mode.
    // With ':' split, it correctly takes configPath → "encrypted".
    process.env.COMIS_CONFIG_PATHS = `${configPath}:${decoyPath}`;

    const program = buildProgram();
    // In encrypted mode (correctly parsed), the flow should reach callTyped.
    // In file mode (wrong parse), it would NOT call callTyped (hits loginOpenAICodexOAuth mock fail).
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--provider",
      "openai-codex",
      "--local",
    ]);

    // callTyped is only called in encrypted mode — prove the ':' split was used
    expect(callTypedMock).toHaveBeenCalledTimes(1);
    expect(callTypedMock.mock.calls[0][1]).toMatchObject({ method: "auth.set" });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
