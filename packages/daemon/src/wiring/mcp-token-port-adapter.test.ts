// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the R8 port-backed MCP token store adapter.
 *
 * RED phase: all tests in "R8 port-backed adapter" describe block fail because
 * packages/daemon/src/wiring/mcp-token-port-adapter.ts does not exist yet.
 *
 * Invariants verified:
 * - saveTokens syncs the token triple to OAuthCredentialStorePort
 * - startWatch delegates to the underlying createTokenStore's startWatch
 * - close() delegates to the underlying createTokenStore's close()
 * - MCP tokens are stored under the data-dir path (not workspace)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This import will fail until mcp-token-port-adapter.ts is created (RED state).
import { createPortBackedMcpTokenStore } from "./mcp-token-port-adapter.js";

import type { OAuthCredentialStorePort, OAuthProfile } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal silent logger satisfying TokenStoreDeps.logger. */
function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Minimal OAuthCredentialStorePort mock. */
function makePortMock(): OAuthCredentialStorePort & {
  _setCallArgs: Array<{ profileId: string; profile: OAuthProfile }>;
} {
  const _setCallArgs: Array<{ profileId: string; profile: OAuthProfile }> = [];
  return {
    _setCallArgs,
    async get(profileId: string) {
      return { ok: true as const, value: undefined };
    },
    async set(profileId: string, profile: OAuthProfile) {
      _setCallArgs.push({ profileId, profile });
      return { ok: true as const, value: undefined };
    },
    async delete(profileId: string) {
      return { ok: true as const, value: false };
    },
    async list(filter?: { provider?: string }) {
      return { ok: true as const, value: [] };
    },
    async has(profileId: string) {
      return { ok: true as const, value: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("R8 port-backed adapter", () => {
  let dir: string;
  let logger: ReturnType<typeof makeLogger>;
  let port: ReturnType<typeof makePortMock>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-port-adapter-test-"));
    logger = makeLogger();
    port = makePortMock();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("createPortBackedMcpTokenStore syncs token triple to OAuthCredentialStorePort on saveTokens", async () => {
    const store = createPortBackedMcpTokenStore(port, {
      tokensDir: dir,
      confinedBaseDir: dir,
      now: () => 1_700_000_000_000,
      logger,
    });

    await store.saveTokens("higgsfield", {
      access_token: "hf_xxx",
      refresh_token: "hfr_yyy",
      expires_in: 3600,
      token_type: "Bearer",
    });

    // Port.set must have been called with the correct profile
    expect(port._setCallArgs).toHaveLength(1);
    const call = port._setCallArgs[0];
    expect(call.profileId).toBe("mcp-oauth:higgsfield");
    expect(call.profile.provider).toBe("mcp-oauth");
    expect(call.profile.profileId).toBe("mcp-oauth:higgsfield");
    expect(call.profile.access).toBe("hf_xxx");
    expect(call.profile.refresh).toBe("hfr_yyy");
    expect(call.profile.version).toBe(1);
    // expires is epoch ms (now + 3600*1000)
    expect(call.profile.expires).toBe(1_700_000_000_000 + 3600 * 1000);
  });

  it("port-backed adapter preserves chokidar startWatch — startWatch completes after wrapping", async () => {
    const store = createPortBackedMcpTokenStore(port, {
      tokensDir: dir,
      confinedBaseDir: dir,
      logger,
      watchPersistent: true,
    });

    // startWatch must succeed (delegates to the underlying createTokenStore)
    await expect(store.startWatch()).resolves.toBeUndefined();

    // Cleanup
    await store.close();
  });

  it("port-backed adapter close() delegates to the underlying store (no leaked handles)", async () => {
    const store = createPortBackedMcpTokenStore(port, {
      tokensDir: dir,
      confinedBaseDir: dir,
      logger,
      watchPersistent: true,
    });

    await store.startWatch();
    // close() must resolve cleanly — if delegation is broken, this may hang
    await expect(store.close()).resolves.toBeUndefined();
    // Idempotent
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("MCP OAuth token saveTokens stores under the data-dir tokensDir path (not workspace/)", async () => {
    // This test verifies the token lands in the injected tokensDir (data dir),
    // NOT in a workspace/ path. We verify by checking the file is created
    // inside 'dir' (our injected tokensDir).
    const store = createPortBackedMcpTokenStore(port, {
      tokensDir: dir,
      confinedBaseDir: dir,
      now: () => 1_700_000_000_000,
      logger,
    });

    await store.saveTokens("testserver", {
      access_token: "tok",
      expires_in: 60,
      token_type: "Bearer",
    });

    // The token file must exist in the injected data-dir (dir), proving
    // it is NOT written to a workspace path.
    const { existsSync: exists } = await import("node:fs");
    expect(exists(join(dir, "testserver.json"))).toBe(true);
  });

  it("port write failure is non-fatal — saveTokens still succeeds when port.set rejects", async () => {
    const failingPort: OAuthCredentialStorePort = {
      async get() { return { ok: true as const, value: undefined }; },
      async set() { return { ok: false as const, error: new Error("port write failed") }; },
      async delete() { return { ok: true as const, value: false }; },
      async list() { return { ok: true as const, value: [] }; },
      async has() { return { ok: true as const, value: false }; },
    };

    const store = createPortBackedMcpTokenStore(failingPort, {
      tokensDir: dir,
      confinedBaseDir: dir,
      now: () => 1_700_000_000_000,
      logger,
    });

    // Must NOT throw even when port.set returns an error result
    await expect(
      store.saveTokens("srv", { access_token: "at", expires_in: 60, token_type: "Bearer" }),
    ).resolves.toBeUndefined();
  });
});
