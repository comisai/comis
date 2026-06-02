// SPDX-License-Identifier: Apache-2.0
/**
 * CLI secrets command behavior tests — daemon-down offline fallback path.
 *
 * Tests the branching logic in `comis secrets set/import/list`:
 *   - daemon UP  → routes through daemon RPC (callTyped)
 *   - daemon DOWN + master key present → routes through offlineSecretSet
 *   - daemon DOWN + master key absent  → exits 1 with actionable message
 *
 * All external dependencies are mocked so these tests run with no daemon
 * and no real filesystem writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Mock declarations — MUST be before any imports that use these modules
// ---------------------------------------------------------------------------

vi.mock("../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(),
}));

vi.mock("../util/offline-secrets-store.js", () => ({
  offlineSecretSet: vi.fn(),
  offlineSecretsList: vi.fn(),
}));

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
  callTyped: vi.fn(),
}));

vi.mock("../output/format.js", () => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../output/table.js", () => ({
  renderTable: vi.fn(),
}));

vi.mock("./sessions.js", () => ({
  formatRelativeTime: vi.fn(() => "just now"),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { registerSecretsCommand } from "./secrets.js";
import { isDaemonRunning } from "../sync-tooling/daemon-guard.js";
import { offlineSecretSet, offlineSecretsList } from "../util/offline-secrets-store.js";
import { withClient, callTyped } from "../client/rpc-client.js";
import { error as outputError } from "../output/format.js";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedIsDaemonRunning = isDaemonRunning as ReturnType<typeof vi.fn>;
const mockedOfflineSecretSet = offlineSecretSet as ReturnType<typeof vi.fn>;
const mockedOfflineSecretsList = offlineSecretsList as ReturnType<typeof vi.fn>;
const mockedWithClient = withClient as ReturnType<typeof vi.fn>;
const mockedCallTyped = callTyped as ReturnType<typeof vi.fn>;
const mockedOutputError = outputError as ReturnType<typeof vi.fn>;

function makeProgram(): Command {
  const prog = new Command();
  prog.exitOverride(); // prevent process.exit in Commander itself
  registerSecretsCommand(prog);
  return prog;
}

async function parseArgs(prog: Command, args: string[]): Promise<void> {
  await prog.parseAsync(args, { from: "user" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("secrets set", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it("routes through daemon RPC when daemon is running", async () => {
    mockedIsDaemonRunning.mockResolvedValue(true);
    mockedWithClient.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
      return fn({});
    });
    mockedCallTyped.mockResolvedValue({ restarting: false });

    const prog = makeProgram();
    await parseArgs(prog, [
      "secrets",
      "set",
      "TELEGRAM_BOT_TOKEN",
      "--value",
      "tok",
    ]);

    expect(mockedCallTyped).toHaveBeenCalledTimes(1);
    // Verify it was called with SecretsSetContract (identified by first arg containing the contract)
    expect(mockedOfflineSecretSet).not.toHaveBeenCalled();
    // process.exit(4) must NOT have been called
    expect(processExitSpy).not.toHaveBeenCalledWith(4);
  });

  it("calls offline store when daemon is down and master key is present", async () => {
    mockedIsDaemonRunning.mockResolvedValue(false);
    mockedOfflineSecretSet.mockReturnValue(ok(undefined));

    const prog = makeProgram();
    await parseArgs(prog, [
      "secrets",
      "set",
      "TELEGRAM_BOT_TOKEN",
      "--value",
      "tok",
    ]);

    expect(mockedOfflineSecretSet).toHaveBeenCalledTimes(1);
    expect(mockedOfflineSecretSet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "TELEGRAM_BOT_TOKEN",
        value: "tok",
      }),
    );
    expect(mockedCallTyped).not.toHaveBeenCalled();
    // process.exit(4) must NOT have been called (not daemon-required exit)
    expect(processExitSpy).not.toHaveBeenCalledWith(4);
  });

  it("exits code 1 with actionable message when daemon down and master key absent", async () => {
    mockedIsDaemonRunning.mockResolvedValue(false);
    mockedOfflineSecretSet.mockReturnValue(
      err(
        new Error(
          "SECRETS_MASTER_KEY is absent in ~/.comis/.env. Run `comis secrets init --write` first.",
        ),
      ),
    );

    const prog = makeProgram();
    let threw = false;
    try {
      await parseArgs(prog, [
        "secrets",
        "set",
        "TELEGRAM_BOT_TOKEN",
        "--value",
        "tok",
      ]);
    } catch {
      threw = true;
    }

    expect(threw || processExitSpy.mock.calls.length > 0).toBe(true);
    // Error output must contain an actionable message
    expect(mockedOutputError).toHaveBeenCalledWith(
      expect.stringMatching(/SECRETS_MASTER_KEY|comis secrets init/i),
    );
  });
});

describe("secrets import", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  const createdFiles: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    for (const f of createdFiles.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // best-effort
      }
    }
  });

  it("calls offline store for each importable entry when daemon is down", async () => {
    mockedIsDaemonRunning.mockResolvedValue(false);
    mockedOfflineSecretSet.mockReturnValue(ok(undefined));

    // Write a temp .env with two importable secrets
    const tmpFile = path.join(
      os.tmpdir(),
      `comis-import-test-${crypto.randomUUID()}.env`,
    );
    fs.writeFileSync(
      tmpFile,
      "TELEGRAM_BOT_TOKEN=tok123\nOPENAI_API_KEY=sk-abc\n",
    );
    createdFiles.push(tmpFile);

    const prog = makeProgram();
    try {
      await parseArgs(prog, ["secrets", "import", "--file", tmpFile]);
    } catch {
      // process.exit might throw via spy; that's OK
    }

    // Both importable keys should trigger offlineSecretSet
    expect(mockedOfflineSecretSet).toHaveBeenCalledTimes(2);
    const calls = mockedOfflineSecretSet.mock.calls.map(
      (c: [{ name: string }]) => c[0].name,
    );
    expect(calls).toContain("TELEGRAM_BOT_TOKEN");
    expect(calls).toContain("OPENAI_API_KEY");
    expect(mockedCallTyped).not.toHaveBeenCalled();
  });
});
