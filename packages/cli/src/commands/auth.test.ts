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
import { registerAuthCommand, resolveCliConfigPath, loadStorageMode, DEFAULT_CONFIG_PATHS } from "./auth.js";

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

// ---------------------------------------------------------------------------
// loadStorageMode env-ref resolution (TDD RED tests — Task 1 of plan 260602-rtj)
//
// Bug 2: loadStorageMode calls loadConfigFile without getSecret, so
// ${VAR} refs are not resolved before validateConfig. A config whose
// gateway.tokens[0].secret is written as ${COMIS_GATEWAY_TOKEN} fails
// Zod min(32) validation (the literal ref is 22 chars) → exit:1.
//
// These tests must FAIL on the pre-patch code (RED). After the fix
// (GREEN), loadStorageMode loads ~/.comis/.env before validating so refs
// are resolved correctly.
// ---------------------------------------------------------------------------

describe("loadStorageMode env-ref resolution", () => {
  let tmpDir: string;
  let configPath: string;
  let envPath: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    const nodeFs = await import("node:fs");
    const nodeOs = await import("node:os");
    const nodePath = await import("node:path");

    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "comis-envref-"));
    configPath = nodePath.join(tmpDir, "config.yaml");
    envPath = nodePath.join(tmpDir, ".env");

    // Config with a gateway token whose secret is an ${ENV} ref (22 chars —
    // below the Zod min:32 threshold). loadStorageMode must resolve the ref
    // via loadEnvFile before validateConfig or it will exit:1.
    nodeFs.writeFileSync(
      configPath,
      [
        "security:",
        "  storage: encrypted",
        "gateway:",
        "  tokens:",
        '    - id: api-token',
        '      secret: "${COMIS_GATEWAY_TOKEN}"',
      ].join("\n"),
    );
    // The .env file provides the resolved value (34 chars — above min:32).
    nodeFs.writeFileSync(envPath, "COMIS_GATEWAY_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");

    // eslint-disable-next-line no-restricted-syntax -- test sets env for isolation
    process.env.COMIS_CONFIG_PATHS = configPath;
    // eslint-disable-next-line no-restricted-syntax -- test sets env for isolation
    process.env.COMIS_DATA_DIR = tmpDir;

    // Reset mocked modules to their default passing states
    const rpcClientMod = await import("../client/rpc-client.js");
    const daemonRequiredMod = await import("../util/daemon-required.js");
    (rpcClientMod.withClient as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (c: unknown) => unknown) => fn({}),
    );
    (rpcClientMod.callTyped as ReturnType<typeof vi.fn>).mockResolvedValue({ profiles: [] });
    (daemonRequiredMod.requireDaemonOrExit as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // eslint-disable-next-line no-restricted-syntax -- cleanup
    delete process.env.COMIS_CONFIG_PATHS;
    // eslint-disable-next-line no-restricted-syntax -- cleanup
    delete process.env.COMIS_DATA_DIR;
    // eslint-disable-next-line no-restricted-syntax -- cleanup
    delete process.env.COMIS_GATEWAY_TOKEN;
    const nodeFs = await import("node:fs");
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadStorageMode resolves ${ENV} refs from .env before validateConfig so auth list does not exit:1", async () => {
    // PRE-FIX (RED): loadStorageMode calls loadConfigFile without getSecret.
    // validateConfig receives the literal "${COMIS_GATEWAY_TOKEN}" (22 chars)
    // which fails z.string().min(32) → process.exit(1).
    //
    // POST-FIX (GREEN): loadStorageMode calls loadEnvFile(dataDir/.env) first,
    // then loadConfigFile(configPath, { getSecret: k => process.env[k] }).
    // The ref resolves to 34 chars → validateConfig passes → encrypted mode.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = new Command();
    registerAuthCommand(program);

    // Must NOT exit:1 — the ref should be resolved before schema validation.
    await expect(
      program.parseAsync(["node", "test", "auth", "list"]),
    ).resolves.not.toThrow();

    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// loadStorageMode with secrets in the ENCRYPTED store (live VPS incident
// 2026-06-19: `comis auth list` reported "No OAuth profiles stored" against a
// daemon that was successfully USING an encrypted openai-codex OAuth profile).
//
// In encrypted mode the load-bearing secrets (COMIS_GATEWAY_TOKEN, bot token)
// live in secrets.db — UNREACHABLE from the CLI (no SECRETS_MASTER_KEY-backed
// store access). The prior fix (plan 260602-rtj) only resolved refs that live
// in ~/.comis/.env; it does NOT cover the encrypted-secrets-db reality, where
// loadConfigFile({ getSecret: process.env }) fails the ${VAR} substitution and
// loadStorageMode silently degraded to "file" → the encrypted OAuth profiles
// became invisible to `auth list/logout/status`.
//
// Reading security.storage needs NONE of those secrets. loadStorageMode must
// pre-read the mode from YAML (preReadStorageMode: no substitution, no Zod)
// and return "encrypted". RED on pre-patch code (returns "file").
// ---------------------------------------------------------------------------
describe("loadStorageMode with secrets in the encrypted store (not .env)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    const nodeFs = await import("node:fs");
    const nodeOs = await import("node:os");
    const nodePath = await import("node:path");
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "comis-encstore-"));
    configPath = nodePath.join(tmpDir, "config.yaml");
    // Encrypted-mode config whose gateway token + bot token are ${VAR} refs
    // resolved ONLY from the encrypted secrets.db — there is NO .env carrying
    // them (the .env here holds only the master key, mirroring the live box).
    nodeFs.writeFileSync(
      configPath,
      [
        "security:",
        "  storage: encrypted",
        "gateway:",
        "  tokens:",
        "    - id: default",
        '      secret: "${COMIS_GATEWAY_TOKEN}"',
        "channels:",
        "  telegram:",
        "    enabled: true",
        '    botToken: "${TELEGRAM_BOT_TOKEN}"',
      ].join("\n"),
    );
    nodeFs.writeFileSync(nodePath.join(tmpDir, ".env"), "SECRETS_MASTER_KEY=deadbeef\n");
    // eslint-disable-next-line no-restricted-syntax -- test sets env for isolation
    process.env.COMIS_CONFIG_PATHS = configPath;
    // eslint-disable-next-line no-restricted-syntax -- test sets env for isolation
    process.env.COMIS_DATA_DIR = tmpDir;
    // Critical: the refs are NOT in process.env (they live in secrets.db).
    // eslint-disable-next-line no-restricted-syntax -- ensure unresolved
    delete process.env.COMIS_GATEWAY_TOKEN;
    // eslint-disable-next-line no-restricted-syntax -- ensure unresolved
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // eslint-disable-next-line no-restricted-syntax -- cleanup
    delete process.env.COMIS_CONFIG_PATHS;
    // eslint-disable-next-line no-restricted-syntax -- cleanup
    delete process.env.COMIS_DATA_DIR;
    const nodeFs = await import("node:fs");
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'encrypted' when the config sets it but secrets are unreachable from the CLI", async () => {
    // PRE-FIX (RED): loadConfigFile({ getSecret: process.env }) fails the
    // ${COMIS_GATEWAY_TOKEN} substitution → loadStorageMode returns "file".
    // POST-FIX (GREEN): preReadStorageMode reads `security.storage: encrypted`
    // straight from YAML, needing no secret → returns "encrypted".
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(loadStorageMode()).resolves.toBe("encrypted");
  });
});

describe("resolveCliConfigPath — default config discovery (no explicit COMIS_CONFIG_PATHS)", () => {
  it("honors an explicit COMIS_CONFIG_PATHS (first colon-separated entry) over everything", () => {
    // existsFn returns true for nothing relevant — explicit path wins regardless.
    expect(resolveCliConfigPath({ COMIS_CONFIG_PATHS: "/x/cfg.yaml:/y/other.yaml" }, () => false))
      .toBe("/x/cfg.yaml");
  });

  it("follows $COMIS_DATA_DIR/config.yaml when set (no COMIS_CONFIG_PATHS) — the daemon's data-dir convention", () => {
    const exists = (p: string) => p === "/data/config.yaml";
    expect(resolveCliConfigPath({ COMIS_DATA_DIR: "/data" }, exists)).toBe("/data/config.yaml");
  });

  it("falls back to the first EXISTING default path (e.g. /etc/comis) when no env vars are set", () => {
    // Previously auth.ts checked ONLY ~/.comis/config.yaml and would have missed this.
    const exists = (p: string) => p === "/etc/comis/config.yaml";
    expect(resolveCliConfigPath({}, exists)).toBe("/etc/comis/config.yaml");
  });

  it("returns the conventional ~/.comis/config.yaml when nothing exists (fresh install)", () => {
    expect(resolveCliConfigPath({}, () => false)).toBe(DEFAULT_CONFIG_PATHS[0]);
  });
});
