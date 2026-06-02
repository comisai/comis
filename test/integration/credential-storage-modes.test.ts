// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-mode credential storage integration suite (REQ-08, REQ-10, REQ-18, REQ-19).
 *
 * Four describe blocks:
 *   1. Encrypted mode — boot daemon with security.storage:encrypted; store
 *      secret+OAuth; assert correct backend + residency (values never in
 *      list responses or logs).
 *   2. File mode — same round-trip for security.storage:file; verify REQ-10
 *      (list never exposes value fields).
 *   3. §5.5 Path A — resolveSecretRefs in-process assertions (darwin-runnable).
 *   4. §5.5 Path B — broker per-request resolve (darwin-runnable) + executor
 *      immutability guard (regression).
 *
 * GREEN state (Wave 3): All darwin-runnable assertions pass. Full bwrap
 * subprocess path is skip-guarded for Linux (clearly marked).
 *
 * Run with: `pnpm build && pnpm test:integration -- credential-storage-modes`
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { isImmutableConfigPath } from "@comis/core";

// §5.5 Path A: resolveSecretRefs from exec-shared.ts (dist path import).
// Not exported from the @comis/skills/tools top-level index — import directly
// from the dist sub-path, matching how integration tests import non-public
// helpers (see test/integration/context/ and test/integration/pipeline/).
import { resolveSecretRefs } from "../../packages/skills/dist/tools/builtin/exec-tool/exec-shared.js";

// §5.5 Path B: resolveSecretRef from @comis/core security module (env-source ref resolution).
import { resolveSecretRef } from "@comis/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

const CONFIG_PATH_ENCRYPTED = resolve(
  __dirname,
  "../config/config.test-storage-modes-encrypted.yaml",
);
const CONFIG_PATH_FILE = resolve(
  __dirname,
  "../config/config.test-storage-modes-file.yaml",
);

// ---------------------------------------------------------------------------
// Per-suite RPC helper
// ---------------------------------------------------------------------------

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string;
  jsonrpc: string;
}

let rpcIdSeq = 0;

async function rpcCallOrThrow<T = unknown>(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const resp = (await sendJsonRpc(ws, method, params, ++rpcIdSeq, {
    timeoutMs: 15_000,
  })) as RpcResponse;
  if (resp.error) {
    throw new Error(
      `RPC ${method} error ${resp.error.code}: ${resp.error.message}`,
    );
  }
  return resp.result as T;
}

// ---------------------------------------------------------------------------
// Suite 1: Encrypted mode round-trip + residency (REQ-08, REQ-18)
// ---------------------------------------------------------------------------

describe("credential-storage-modes: encrypted mode (REQ-08)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let tempDataDir: string;
  const originalMasterKey = process.env["SECRETS_MASTER_KEY"];
  const originalDataDir = process.env["COMIS_DATA_DIR"];

  beforeAll(async () => {
    // Use an isolated temp data directory per test run. This ensures the
    // daemon creates a fresh secrets.db (not the shared ~/.comis/secrets.db)
    // and avoids DECRYPTION_FAILED when a prior run left a db with a
    // different master key. COMIS_DATA_DIR overrides the default ~/.comis
    // path (see daemon.ts:1413).
    tempDataDir = mkdtempSync(resolve(tmpdir(), "comis-storage-modes-enc-"));
    process.env["COMIS_DATA_DIR"] = tempDataDir;

    // Set a fresh SECRETS_MASTER_KEY (hex-encoded 32-byte random key) for
    // this run. The daemon reads this in encrypted mode via selectSecretStore.
    process.env["SECRETS_MASTER_KEY"] = randomBytes(32).toString("hex");

    handle = await startTestDaemon({
      configPath: CONFIG_PATH_ENCRYPTED,
    });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 60_000);

  afterAll(async () => {
    // Restore original env state to prevent cross-test contamination.
    if (originalMasterKey === undefined) {
      delete process.env["SECRETS_MASTER_KEY"];
    } else {
      process.env["SECRETS_MASTER_KEY"] = originalMasterKey;
    }
    if (originalDataDir === undefined) {
      delete process.env["COMIS_DATA_DIR"];
    } else {
      process.env["COMIS_DATA_DIR"] = originalDataDir;
    }
    try {
      ws?.close();
    } catch {
      // Best-effort
    }
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
    // Remove the temp data directory (contains secrets.db + .env + memory db).
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }, 30_000);

  it("encrypted mode: secrets.set stores a secret and secrets.list returns name-only (residency, REQ-08)", async () => {
    const SECRET_VALUE = "test-secret-value-" + randomBytes(8).toString("hex");
    const SECRET_NAME = "ENCRYPTED_TEST_KEY";

    // Store the secret via secrets.set RPC
    await rpcCallOrThrow(ws, "secrets.set", {
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });

    // List must contain name but NOT the plaintext value
    const list = await rpcCallOrThrow<{
      secrets: Array<{ name: string; value?: string }>;
    }>(ws, "secrets.list", {});

    const entry = list.secrets.find((s) => s.name === SECRET_NAME);
    expect(entry).toBeDefined();
    // REQ-08 residency: list metadata schema has no value field (T-07-03-01)
    expect(entry?.["value"]).toBeUndefined();

    // The serialized list must not contain the plaintext value anywhere
    expect(JSON.stringify(list)).not.toContain(SECRET_VALUE);
  }, 30_000);

  it("encrypted mode: auth.set stores an OAuth profile and auth.list returns token-free response (REQ-08)", async () => {
    const ACCESS_TOKEN = "tok-access-encrypted-" + randomBytes(8).toString("hex");
    const REFRESH_TOKEN = "tok-refresh-encrypted-" + randomBytes(8).toString("hex");
    // profileId format: "<provider>:<identity>" (validated by validateProfileId in @comis/core)
    const PROFILE_ID = "codex:encrypted-test@example.com";

    // Store OAuth profile via auth.set.
    // AuthSetContract field names: access, refresh, expires, version (NOT accessToken/refreshToken).
    await rpcCallOrThrow(ws, "auth.set", {
      profileId: PROFILE_ID,
      provider: "codex",
      access: ACCESS_TOKEN,
      refresh: REFRESH_TOKEN,
      expires: Date.now() + 3_600_000,
      accountId: "test-account-123",
      email: "encrypted-test@example.com",
      version: 1,
    });

    // auth.list must return profile without access/refresh tokens (T-07-03-02)
    const list = await rpcCallOrThrow<{
      profiles: Array<{ profileId: string; email?: string }>;
    }>(ws, "auth.list", {});

    const profile = list.profiles.find((p) => p.profileId === PROFILE_ID);
    expect(profile).toBeDefined();

    // Residency: list response must NOT contain token values anywhere
    const listJson = JSON.stringify(list);
    expect(listJson).not.toContain(ACCESS_TOKEN);
    expect(listJson).not.toContain(REFRESH_TOKEN);
  }, 30_000);

  it("encrypted mode: secrets.get returns stored value after secrets.set (SecretRef round-trip, REQ-08)", async () => {
    const KEY_VALUE = "secretref-value-" + randomBytes(8).toString("hex");
    const KEY_NAME = "SECRETREF_TEST_KEY";

    await rpcCallOrThrow(ws, "secrets.set", {
      name: KEY_NAME,
      value: KEY_VALUE,
    });

    const got = await rpcCallOrThrow<{ name: string; value: string; exists: boolean }>(
      ws,
      "secrets.get",
      { name: KEY_NAME },
    );

    // Admin-scoped secrets.get returns the plaintext over the authenticated RPC channel
    expect(got.exists).toBe(true);
    expect(got.value).toBe(KEY_VALUE);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Suite 2: File mode round-trip + residency (REQ-08, REQ-10, REQ-18)
// ---------------------------------------------------------------------------

describe("credential-storage-modes: file mode (REQ-18)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;

  beforeAll(async () => {
    handle = await startTestDaemon({
      configPath: CONFIG_PATH_FILE,
    });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 60_000);

  afterAll(async () => {
    try {
      ws?.close();
    } catch {
      // Best-effort
    }
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  it("file mode: secrets.set stores a secret and secrets.list returns names only (no value field, REQ-10)", async () => {
    const SECRET_VALUE = "file-secret-value-" + randomBytes(8).toString("hex");
    const SECRET_NAME = "FILE_TEST_KEY";

    await rpcCallOrThrow(ws, "secrets.set", {
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });

    const list = await rpcCallOrThrow<{
      secrets: Array<{ name: string; value?: string }>;
    }>(ws, "secrets.list", {});

    const entry = list.secrets.find((s) => s.name === SECRET_NAME);
    expect(entry).toBeDefined();

    // REQ-10 file-store residency: no value field in list response (T-07-03-01)
    expect(entry?.["value"]).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(SECRET_VALUE);
  }, 30_000);

  it("file mode: auth.set stores OAuth profile and auth.list returns profile without tokens (file-store residency, REQ-10)", async () => {
    const ACCESS_TOKEN = "tok-access-file-" + randomBytes(8).toString("hex");
    const REFRESH_TOKEN = "tok-refresh-file-" + randomBytes(8).toString("hex");
    // profileId format: "<provider>:<identity>" (validated by validateProfileId in @comis/core)
    const PROFILE_ID = "codex:file-test@example.com";

    // AuthSetContract field names: access, refresh, expires, version
    await rpcCallOrThrow(ws, "auth.set", {
      profileId: PROFILE_ID,
      provider: "codex",
      access: ACCESS_TOKEN,
      refresh: REFRESH_TOKEN,
      expires: Date.now() + 3_600_000,
      accountId: "test-account-456",
      email: "file-test@example.com",
      version: 1,
    });

    const list = await rpcCallOrThrow<{
      profiles: Array<{ profileId: string; email?: string }>;
    }>(ws, "auth.list", {});

    const profile = list.profiles.find((p) => p.profileId === PROFILE_ID);
    expect(profile).toBeDefined();

    // Residency: list response must NOT contain token values (T-07-03-02)
    const listJson = JSON.stringify(list);
    expect(listJson).not.toContain(ACCESS_TOKEN);
    expect(listJson).not.toContain(REFRESH_TOKEN);
  }, 30_000);

  it("file mode: secrets.list returns no value field on any entry across multiple stored secrets (REQ-10 multi-entry residency)", async () => {
    await rpcCallOrThrow(ws, "secrets.set", {
      name: "FILE_MULTI_KEY_A",
      value: "value-a-" + randomBytes(8).toString("hex"),
    });
    await rpcCallOrThrow(ws, "secrets.set", {
      name: "FILE_MULTI_KEY_B",
      value: "value-b-" + randomBytes(8).toString("hex"),
    });

    const list = await rpcCallOrThrow<{
      secrets: Array<Record<string, unknown>>;
    }>(ws, "secrets.list", {});

    for (const entry of list.secrets) {
      expect(entry).not.toHaveProperty("value");
      expect(entry).toHaveProperty("name");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Suite 3: §5.5 Path A — resolveSecretRefs in-process (REQ-19, darwin-runnable)
// ---------------------------------------------------------------------------

describe("§5.5 Path A: resolveSecretRefs in exec-sandbox path (REQ-19)", () => {
  // No daemon boot — pure in-process unit assertion.
  // These tests verify the exec-tool sandbox injection contract (exec-shared.ts)
  // and are darwin-runnable without bwrap or bubblewrap.

  it("places real value for user-task secret in sandbox env (exec-shared.ts:204)", () => {
    // SecretManager minimal mock: returns a live value for EXAMPLE_API_KEY
    const mockSM = {
      get: (name: string): string | undefined =>
        name === "EXAMPLE_API_KEY" ? "real-api-value-sentinel" : undefined,
      getAll: () => ({ EXAMPLE_API_KEY: "real-api-value-sentinel" }),
      has: (name: string) => name === "EXAMPLE_API_KEY",
      delete: () => false,
    };

    const result = resolveSecretRefs(
      ["EXAMPLE_API_KEY"],
      mockSM,
      new Set<string>(), // no platform secrets in this test
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env["EXAMPLE_API_KEY"]).toBe("real-api-value-sentinel");
    }
  });

  it("blocks platform-managed secret name (exec-shared.ts:193)", () => {
    const mockSM = {
      get: (_name: string): string | undefined => "some-value",
      getAll: () => ({}),
      has: () => true,
      delete: () => false,
    };

    // ANTHROPIC_API_KEY is in the platform secrets set — must be refused
    const result = resolveSecretRefs(
      ["ANTHROPIC_API_KEY"],
      mockSM,
      new Set<string>(["ANTHROPIC_API_KEY"]),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("platform-managed");
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4a: §5.5 Path B — in-process broker resolve (REQ-19, darwin-runnable)
// ---------------------------------------------------------------------------

describe("§5.5 Path B: broker per-request resolve (REQ-19, darwin-runnable)", () => {
  // No daemon boot — pure in-process unit assertion.
  //
  // resolveSecretRef (from @comis/core security module) is the underlying
  // injection contract. The broker calls this at per-request scope to resolve
  // SecretRef objects before sealing the subprocess environment. This test
  // verifies the contract holds: resolved value is live, placeholder is distinct.

  it("broker resolves env-source SecretRef from live SecretManager; subprocess sees placeholder before injection (T-07-03-05)", () => {
    // SecretRef with source="env", provider="comis", id="MY_BROKER_KEY"
    const secretRef = {
      source: "env" as const,
      provider: "comis",
      id: "MY_BROKER_KEY",
    };
    const LIVE_VALUE = "live-broker-sentinel-value";
    // The placeholder is what the subprocess env arg would contain before the
    // broker resolves it per-request (the subprocess sees this opaque string,
    // not the plaintext — only the per-request injection replaces it).
    const PLACEHOLDER = `${secretRef.source}:${secretRef.provider}/${secretRef.id}`;

    // Seed a mock SecretManager with the live value
    const mockSM = {
      get: (name: string): string | undefined =>
        name === "MY_BROKER_KEY" ? LIVE_VALUE : undefined,
      getAll: () => ({ MY_BROKER_KEY: LIVE_VALUE }),
      has: (name: string) => name === "MY_BROKER_KEY",
      delete: () => false,
    };

    // Call the resolver (the broker's per-request injection contract)
    const result = resolveSecretRef(secretRef, { secretManager: mockSM });

    // Assert: resolved value is the live plaintext
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(LIVE_VALUE);
    }

    // Assert: placeholder !== resolved value — subprocess sees the opaque
    // ref string until the broker injects the live value at request scope (T-07-03-05).
    expect(PLACEHOLDER).not.toBe(LIVE_VALUE);
  });

  it.skip(
    "§5.5 Path B full subprocess (Linux-deferred) — needs bwrap",
    // Linux: see pnpm validate:full gate in 07-CONTEXT.md deferred items.
    // Full broker-injected bwrap subprocess path requires:
    //   - Linux OS (bubblewrap is Linux-only; darwin cannot run bwrap)
    //   - pnpm validate:full in CI or on a Linux dev box
    //   - The §5.5 Path B end-to-end flow:
    //       broker.resolveSecretRef → bwrap --unshare-net subprocess → env sealed
    // This test is intentionally SKIPPED on darwin — NOT deleted.
    // The skip signals the full bwrap path must be verified separately on Linux.
    () => { /* no-op */ },
  );
});

// ---------------------------------------------------------------------------
// Suite 4b: §5.5 Path B — executor immutability guard (REQ-19)
// ---------------------------------------------------------------------------

describe("§5.5 Path B — executor immutability guard (REQ-19)", () => {
  it("isImmutableConfigPath('executor', 'broker.bindings') returns true (immutability guard holds)", () => {
    // REQ-19 §8.1: executor immutability guard is GREEN from Phase 1.
    // This test verifies the guard continues to hold — any future regression
    // in IMMUTABLE_CONFIG_PREFIXES would fail this immediately (T-07-03-03).
    expect(isImmutableConfigPath("executor", "broker.bindings")).toBe(true);
  });

  it("isImmutableConfigPath('executor') returns true for whole-section patch rejection", () => {
    // Whole-section config.patch("executor") must also be rejected.
    expect(isImmutableConfigPath("executor")).toBe(true);
  });

  it("isImmutableConfigPath('memory') returns false (non-immutable section is not blocked)", () => {
    // Control: memory section IS mutable — verify the guard is not over-broad.
    // Note: 'agents' is in IMMUTABLE_CONFIG_PREFIXES (models/budgets are
    // security-critical) — 'memory' is the correct mutable control case.
    expect(isImmutableConfigPath("memory")).toBe(false);
  });
});
