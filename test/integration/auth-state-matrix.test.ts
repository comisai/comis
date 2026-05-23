// SPDX-License-Identifier: Apache-2.0
/**
 * 4-state matrix for `comis auth {list, logout, status}`.
 *
 * Each command must behave correctly across the product:
 *   - oauth.storage ∈ { "file", "encrypted" }
 *   - daemonState ∈ { "up", "down" }
 *
 * Total: 3 commands × 2 storage × 2 daemon states = 12 it.each rows.
 *
 * Expected behavior per cell:
 *   - file/up     → CLI-local; reads file backend directly. Exit 0.
 *   - file/down   → CLI-local; same as file/up (no daemon needed). Exit 0.
 *   - encrypted/up   → daemon RPC `auth.{list,logout}` (admin scope). Exit 0
 *                      (auth.list returns `{profiles:[]}` when oauthCredentialStore
 *                      is undefined; auth.logout returns deleted:false for a
 *                      nonexistent profile). `auth.status` is CLI-local in both
 *                      modes - it consumes `auth.list`'s token-stripped response
 *                      to compute the per-provider summary CLI-locally.
 *   - encrypted/down → CLI's `requireDaemonOrExit` ping fails-closed →
 *                      exit 4 + REMEDIATION_MESSAGE on stderr.
 *
 * The matrix exercises:
 *   - storage-mode-branching in cli/commands/auth.ts
 *   - requireDaemonOrExit gate
 *   - daemon's auth-handlers.ts admin-scoped RPC surface
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import { ok } from "@comis/shared";
import { createSecretsCrypto } from "@comis/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = resolve(__dirname, "../../packages/cli/dist/cli.js");

const FILE_CONFIG_PATH = resolve(__dirname, "../config/config.test-auth-file.yaml");
const ENCRYPTED_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-auth-encrypted.yaml",
);

const FILE_PORT = 8562;
const ENCRYPTED_PORT = 8563;
const FILE_ADMIN_TOKEN = "admin-secret-key-for-auth-file-test";
const ENCRYPTED_ADMIN_TOKEN = "admin-secret-key-for-auth-encrypted-test";

// ---------------------------------------------------------------------------
// Matrix definition
// ---------------------------------------------------------------------------

type Storage = "file" | "encrypted";
type DaemonState = "up" | "down";
type Command = "list" | "logout" | "status";

interface MatrixRow {
  command: Command;
  storage: Storage;
  daemonState: DaemonState;
  expected: {
    exitCode: number;
    stderrContains?: RegExp;
  };
}

// Matrix exit-code expectations note: `logout` with a nonexistent profile
// ID exits 1 in BOTH branches (file and encrypted-up) per the CLI's
// "profile not found" semantics. The matrix's load-bearing assertion is
// the daemon-required contract: encrypted/down -> exit 4 (the daemon probe
// fired before the logout logic ran), versus encrypted/up where the CLI
// reached the daemon and the daemon's auth.logout returned deleted:false
// (then the CLI exits 1 from the user-visible "profile not found" branch).
const MATRIX: readonly MatrixRow[] = [
  // file storage: daemon state is irrelevant - all CLI-local.
  // list/status: empty store -> exit 0 (informational empty render).
  // logout: nonexistent profile -> exit 1 (profile-not-found).
  { command: "list",   storage: "file",      daemonState: "up",   expected: { exitCode: 0 } },
  { command: "list",   storage: "file",      daemonState: "down", expected: { exitCode: 0 } },
  { command: "logout", storage: "file",      daemonState: "up",   expected: { exitCode: 1 } },
  { command: "logout", storage: "file",      daemonState: "down", expected: { exitCode: 1 } },
  { command: "status", storage: "file",      daemonState: "up",   expected: { exitCode: 0 } },
  { command: "status", storage: "file",      daemonState: "down", expected: { exitCode: 0 } },
  // encrypted storage: daemon required for list+logout; status is CLI-local
  // but also uses auth.list internally so it requires the daemon up too.
  { command: "list",   storage: "encrypted", daemonState: "up",   expected: { exitCode: 0 } },
  { command: "list",   storage: "encrypted", daemonState: "down", expected: { exitCode: 4, stderrContains: /requires the comis daemon/ } },
  { command: "logout", storage: "encrypted", daemonState: "up",   expected: { exitCode: 1 } },
  { command: "logout", storage: "encrypted", daemonState: "down", expected: { exitCode: 4, stderrContains: /requires the comis daemon/ } },
  { command: "status", storage: "encrypted", daemonState: "up",   expected: { exitCode: 0 } },
  { command: "status", storage: "encrypted", daemonState: "down", expected: { exitCode: 4, stderrContains: /requires the comis daemon/ } },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("auth {list, logout, status} -- 4-state matrix", () => {
  let activeHandle: TestDaemonHandle | undefined;
  let tempDbPath: string | undefined;

  afterEach(async () => {
    if (activeHandle) {
      try {
        await activeHandle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
      activeHandle = undefined;
    }
    if (tempDbPath) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(tempDbPath + suffix);
        } catch {
          // Best-effort
        }
      }
      tempDbPath = undefined;
    }
  }, 30_000);

  it.each(MATRIX)(
    "$command storage=$storage daemonState=$daemonState -> exit $expected.exitCode",
    async ({ command, storage, daemonState, expected }) => {
      const configPath = storage === "file" ? FILE_CONFIG_PATH : ENCRYPTED_CONFIG_PATH;
      const port = storage === "file" ? FILE_PORT : ENCRYPTED_PORT;
      const adminToken = storage === "file" ? FILE_ADMIN_TOKEN : ENCRYPTED_ADMIN_TOKEN;

      if (daemonState === "up") {
        // Encrypted-mode daemon requires secretsDb + secretsCrypto. Provide
        // them via setupSecrets override (same pattern as secrets-lifecycle).
        if (storage === "encrypted") {
          const testMasterKey = randomBytes(32);
          const crypto = createSecretsCrypto(testMasterKey);
          tempDbPath = `/tmp/comis-test-auth-matrix-${Date.now()}-${randomBytes(4).toString("hex")}.db`;
          activeHandle = await startTestDaemon({
            configPath,
            overrides: {
              setupSecrets: () => ok({ crypto, dbPath: tempDbPath! }),
            },
          });
        } else {
          activeHandle = await startTestDaemon({ configPath });
        }
      }
      // daemonState === "down" -> intentionally no daemon. The CLI will
      // probe the test gateway port (via COMIS_GATEWAY_URL below) and find
      // it unbound; requireDaemonOrExit fires for encrypted storage.

      const args = ["auth", command];
      if (command === "logout") {
        // logout requires --profile. The CLI's storage-key validation in
        // packages/cli/src/commands/auth.ts requires a `<provider>:<identity>`
        // shape via validateProfileId. Use a structurally-valid value that
        // does not exist in the store; the exit-code (1 for both file and
        // encrypted-up due to "profile not found"; 4 for encrypted-down due
        // to requireDaemonOrExit) is the load-bearing assertion.
        args.push("--profile", "openai-codex:matrix-test-nonexistent@example.com");
      }

      const result = await runCli(args, {
        // CLI's loadOAuthStorageMode reads COMIS_CONFIG_PATHS for the
        // oauth.storage section. CLI's rpc-client uses COMIS_GATEWAY_URL /
        // COMIS_GATEWAY_TOKEN for the daemon connection.
        COMIS_CONFIG_PATHS: configPath,
        COMIS_GATEWAY_URL: `ws://127.0.0.1:${port}/ws`,
        COMIS_GATEWAY_TOKEN: adminToken,
      });

      expect(
        result.exitCode,
        `${command}/${storage}/${daemonState}: expected exit ${expected.exitCode} but got ${result.exitCode}. ` +
          `stderr: ${result.stderr.slice(0, 500)}`,
      ).toBe(expected.exitCode);
      if (expected.stderrContains) {
        expect(result.stderr).toMatch(expected.stderrContains);
      }
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Helper: spawn the CLI binary as a subprocess and capture exit + streams.
// ---------------------------------------------------------------------------

async function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const baseEnv = { ...process.env } as Record<string, string | undefined>;
    // Clean inherited keys so the spawned CLI sees ONLY what we set.
    delete baseEnv["COMIS_CONFIG_PATHS"];
    delete baseEnv["COMIS_GATEWAY_URL"];
    delete baseEnv["COMIS_GATEWAY_TOKEN"];
    // VITEST=true propagates to the child node process; under it, withClient
    // refuses real WebSockets unless COMIS_CLI_E2E=true. Opt in here so the
    // CLI subprocess can probe the test daemon over a real socket.
    baseEnv["COMIS_CLI_E2E"] = "true";
    const env: NodeJS.ProcessEnv = { ...baseEnv } as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }

    const proc = spawn("node", [CLI_PATH, ...args], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) =>
      resolveProcess({ exitCode: code ?? 0, stdout, stderr }),
    );
    proc.on("error", rejectProcess);
  });
}
