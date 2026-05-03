// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the `comis auth` CLI command tree (Phase 8 plan 03).
 *
 * Scope: argv parsing + dispatch shape only — full end-to-end behavior
 * (against the mock OAuth server) is covered by the Phase 8 plan 06
 * integration test `test/integration/oauth-login.test.ts`.
 *
 * These tests catch commander wiring regressions (e.g., a typo that
 * loses a subcommand, or a missing requiredOption).
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerAuthCommand } from "./auth.js";

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

  // Phase 9 R4 — `--profile` is no longer rejected; it is validated as an
  // override. The legacy "exit 2 on any --profile value" test was removed
  // because it asserted Phase 8 behavior that R4 deliberately replaces.
  // Coverage for the new acceptance / mismatch / malformed cases lives below
  // (and in the dedicated mock-driven file `auth.profile-override.test.ts`).

  it("rejects --profile with malformed value (forbidden character) with exit 2 (R4)", async () => {
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

  it("rejects --profile when provider portion does not match --provider with exit 2 (R4)", async () => {
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

  it("preserves the existing --provider rejection for non-codex providers (R4)", async () => {
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
  // Phase 11 SC11-1 — --method device-code flag
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
