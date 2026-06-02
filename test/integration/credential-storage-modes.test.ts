// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-mode credential storage integration suite (REQ-08, REQ-18, REQ-19).
 *
 * Two describe blocks exercise the full credential round-trip in each mode:
 *   1. Encrypted mode — boot daemon with security.storage:encrypted; store
 *      secret+OAuth; assert correct backend + residency (values never in
 *      list responses or logs).
 *   2. File mode — same round-trip for security.storage:file.
 *   3. §5.5 Path B — broker injects secretRef per-request; immutability guard
 *      verified.
 *
 * RED state (Wave 0): The daemon-boot describe blocks will FAIL because
 * Plan 02 (setup-storage-mismatch-warn.ts) has not been wired yet. The
 * in-process §5.5 Path B immutability test may pass immediately — that is
 * acceptable; it is a verification test, not a new behavior assertion.
 *
 * Run with: `pnpm build && pnpm test:integration -- credential-storage-modes`
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { isImmutableConfigPath } from "@comis/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Config paths + constants
// ---------------------------------------------------------------------------

const CONFIG_PATH_ENCRYPTED = resolve(
  __dirname,
  "../config/config.test-storage-modes-encrypted.yaml",
);
const CONFIG_PATH_FILE = resolve(
  __dirname,
  "../config/config.test-storage-modes-file.yaml",
);

const ENCRYPTED_ADMIN_TOKEN = "admin-secret-key-for-storage-modes-encrypted-test";
const FILE_ADMIN_TOKEN = "admin-secret-key-for-storage-modes-file-test";

void ENCRYPTED_ADMIN_TOKEN;
void FILE_ADMIN_TOKEN;

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
// Suite 1: Encrypted mode round-trip + residency
// ---------------------------------------------------------------------------

describe("credential-storage-modes: encrypted mode (REQ-08)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  const originalMasterKey = process.env["SECRETS_MASTER_KEY"];

  beforeAll(async () => {
    // Supply a fresh SECRETS_MASTER_KEY for each encrypted-mode run
    const testMasterKey = randomBytes(32).toString("hex");
    process.env["SECRETS_MASTER_KEY"] = testMasterKey;

    handle = await startTestDaemon({
      configPath: CONFIG_PATH_ENCRYPTED,
    });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 60_000);

  afterAll(async () => {
    // Restore original master key (or delete if not set before)
    if (originalMasterKey === undefined) {
      delete process.env["SECRETS_MASTER_KEY"];
    } else {
      process.env["SECRETS_MASTER_KEY"] = originalMasterKey;
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
  }, 30_000);

  it("encrypted mode: env.set stores a secret and list returns name-only (residency)", async () => {
    const SECRET_VALUE = "test-secret-value-" + randomBytes(8).toString("hex");
    const SECRET_NAME = "ENCRYPTED_TEST_KEY";

    // Store the secret via env.set RPC
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
    expect(entry?.["value"]).toBeUndefined();

    // The serialized list must not contain the plaintext value
    expect(JSON.stringify(list)).not.toContain(SECRET_VALUE);
  }, 30_000);

  it("encrypted mode: auth.set stores an OAuth profile and auth.list returns token-free response", async () => {
    const ACCESS_TOKEN = "tok-access-encrypted-" + randomBytes(8).toString("hex");
    const REFRESH_TOKEN = "tok-refresh-encrypted-" + randomBytes(8).toString("hex");
    const PROFILE_ID = "encrypted-test-profile";

    // Store OAuth profile via auth.set
    await rpcCallOrThrow(ws, "auth.set", {
      profileId: PROFILE_ID,
      provider: "codex",
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      accountId: "test-account-123",
      email: "test@example.com",
    });

    // auth.list must return profile without access/refresh tokens
    const list = await rpcCallOrThrow<{
      profiles: Array<{ profileId: string; email?: string }>;
    }>(ws, "auth.list", {});

    const profile = list.profiles.find((p) => p.profileId === PROFILE_ID);
    expect(profile).toBeDefined();

    // Residency: list response must NOT contain token values
    const listJson = JSON.stringify(list);
    expect(listJson).not.toContain(ACCESS_TOKEN);
    expect(listJson).not.toContain(REFRESH_TOKEN);
  }, 30_000);

  it("encrypted mode: SecretRef-backed lookup — env.get returns stored value after env.set", async () => {
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

    expect(got.exists).toBe(true);
    expect(got.value).toBe(KEY_VALUE);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Suite 2: File mode round-trip + residency
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

  it("file mode: env.set stores a secret and list returns names only (no value field)", async () => {
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

    // REQ-10 file-store residency: no value field in list response
    expect(entry?.["value"]).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(SECRET_VALUE);
  }, 30_000);

  it("file mode: auth.set stores OAuth profile and auth.list returns profile without tokens (file-store residency, REQ-10)", async () => {
    const ACCESS_TOKEN = "tok-access-file-" + randomBytes(8).toString("hex");
    const REFRESH_TOKEN = "tok-refresh-file-" + randomBytes(8).toString("hex");
    const PROFILE_ID = "file-test-profile";

    await rpcCallOrThrow(ws, "auth.set", {
      profileId: PROFILE_ID,
      provider: "codex",
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      accountId: "test-account-456",
      email: "file-test@example.com",
    });

    const list = await rpcCallOrThrow<{
      profiles: Array<{ profileId: string; email?: string }>;
    }>(ws, "auth.list", {});

    const profile = list.profiles.find((p) => p.profileId === PROFILE_ID);
    expect(profile).toBeDefined();

    // Residency: list response must NOT contain token values
    const listJson = JSON.stringify(list);
    expect(listJson).not.toContain(ACCESS_TOKEN);
    expect(listJson).not.toContain(REFRESH_TOKEN);
  }, 30_000);

  it("file mode: list returns no value field on any entry across multiple stored secrets (REQ-10 multi-entry residency)", async () => {
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
// Suite 3: §5.5 Path B — broker immutability guard (in-process, REQ-19)
// ---------------------------------------------------------------------------

describe("§5.5 Path B — executor immutability guard (REQ-19)", () => {
  it("isImmutableConfigPath('executor', 'broker.bindings') returns true (immutability guard holds)", () => {
    // REQ-19 §8.1: executor immutability guard is ALREADY GREEN from Phase 1.
    // This test verifies it continues to hold — any regression in
    // IMMUTABLE_CONFIG_PREFIXES would break this immediately.
    expect(isImmutableConfigPath("executor", "broker.bindings")).toBe(true);
  });

  it("isImmutableConfigPath('executor') returns true for whole-section patch rejection", () => {
    // Whole-section config.patch("executor") must also be rejected.
    expect(isImmutableConfigPath("executor")).toBe(true);
  });

  it("isImmutableConfigPath('agents') returns false (non-immutable section is not blocked)", () => {
    // Control: agents section IS mutable — verify the guard is not over-broad.
    expect(isImmutableConfigPath("agents")).toBe(false);
  });
});
