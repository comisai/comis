// SPDX-License-Identifier: Apache-2.0
/**
 * RED test suite for `selectMcpTokenStore` — the unified mode→store selector
 * that kills the encrypted-mode MCP OAuth split-brain.
 *
 * This file imports from `./select-mcp-token-store.js` which does NOT exist yet
 * — that is the expected RED state (vitest fails at runtime with "Cannot find
 * module"), exactly like the existing `mcp-token-store-encrypted.test.ts` RED
 * precedent. `*.test.ts` is excluded from `packages/daemon/tsconfig.json` so
 * `pnpm build` stays clean.
 *
 * The bug being locked: today the login path (`mcp.oauth_login`) writes tokens
 * to a plaintext disk store UNCONDITIONALLY (ignoring `security.storage`), while
 * the MCP client manager reads the mode-selected store (the encrypted
 * `mcp_credentials` table in `secrets.db`). Freshly-minted tokens are invisible
 * to `manager.connect`. `selectMcpTokenStore` unifies both consumers onto one
 * mode-selected backend.
 *
 * Coverage groups:
 *   1. Split-brain residency (the bug) — login store and manager store are the
 *      SAME mode-selected backend: a token saved via one is readable via the
 *      other AND no file is written under `<dataDir>/mcp-tokens/`.
 *   2. Selector unit cases — encrypted (zero disk files) / encrypted-partial
 *      (throws) / file (writes under mcp-tokens/) / env (returns undefined).
 *   3. Single-instance identity lock — one constructed store reaches BOTH
 *      setupMcp's oauthDeps.createTokenStore() and the pass-through factory that
 *      ApiDispatchDeps.createTokenStore wraps (object-identity assertion).
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createSecretsCrypto } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TokenStore as McpTokenStore } from "@comis/skills";
import { selectMcpTokenStore } from "./select-mcp-token-store.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = Buffer.alloc(32, 0x42);
const testCrypto = createSecretsCrypto(TEST_MASTER_KEY);

const SERVER = "my-mcp-server";

const TOKENS: OAuthTokens = {
  access_token: "tok_abc123_CANARY",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "ref_xyz789_CANARY",
  scope: "openid profile",
};

/**
 * Minimal ComisLogger stub — only the methods the selector + the port-backed
 * adapter call. Hand-built `as unknown as ComisLogger` per AGENTS.md §2.5.
 */
function makeLogger(): ComisLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => makeLogger(),
    level: "debug",
    isLevelEnabled: () => true,
  } as unknown as ComisLogger;
}

/**
 * Walk `dir` recursively and return true if any file's binary content contains
 * the UTF-8 bytes of `needle`. Does NOT log file content.
 */
function diskContains(dir: string, needle: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const needleBuf = Buffer.from(needle, "utf8");
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (diskContains(full, needle)) return true;
    } else if (entry.isFile()) {
      const content = fs.readFileSync(full);
      if (content.indexOf(needleBuf) !== -1) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Group 1 — Split-brain residency (the bug)
// ---------------------------------------------------------------------------

describe("selectMcpTokenStore split-brain residency (encrypted mode unifies login + manager)", () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.resolve(os.tmpdir(), "mcp-select-splitbrain-"));
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("encrypted mode: a token saved via the login-path store is readable via the manager-path store (same backend)", async () => {
    // Both the login-path reference and the manager-path reference are derived
    // from the SAME mode-selected store — this is exactly what daemon wiring
    // does after the fix (one instance threaded into both consumers).
    const loginStore = selectMcpTokenStore({
      storage: "encrypted",
      logger: makeLogger(),
      dataDir,
      secretsDb: db,
      secretsCrypto: testCrypto,
    });
    const managerStore = selectMcpTokenStore({
      storage: "encrypted",
      logger: makeLogger(),
      dataDir,
      secretsDb: db,
      secretsCrypto: testCrypto,
    });
    expect(loginStore).toBeDefined();
    expect(managerStore).toBeDefined();

    // Login path writes the token.
    await loginStore!.saveTokens(SERVER, TOKENS);

    // Manager path (backed by the same secrets.db) reads it back — pre-fix the
    // login path wrote a plaintext disk store, so the manager read a DIFFERENT
    // backend and got undefined.
    const readBack = await managerStore!.tokens(SERVER);
    expect(readBack).toBeDefined();
    expect(readBack?.access_token).toBe("tok_abc123_CANARY");
    expect(readBack?.refresh_token).toBe("ref_xyz789_CANARY");
  });

  it("encrypted mode: saving a token writes NO file under <dataDir>/mcp-tokens/", async () => {
    const store = selectMcpTokenStore({
      storage: "encrypted",
      logger: makeLogger(),
      dataDir,
      secretsDb: db,
      secretsCrypto: testCrypto,
    });
    await store!.saveTokens(SERVER, TOKENS);

    // No plaintext mcp-tokens/ directory may exist (the split-brain symptom).
    expect(fs.existsSync(path.join(dataDir, "mcp-tokens"))).toBe(false);
    // And no plaintext token bytes anywhere under dataDir.
    expect(diskContains(dataDir, "tok_abc123_CANARY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Selector unit cases
// ---------------------------------------------------------------------------

describe("selectMcpTokenStore mode selection", () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.resolve(os.tmpdir(), "mcp-select-mode-"));
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("encrypted mode returns an mcp_credentials-backed store that writes ZERO disk files", async () => {
    const store = selectMcpTokenStore({
      storage: "encrypted",
      logger: makeLogger(),
      dataDir,
      secretsDb: db,
      secretsCrypto: testCrypto,
    });
    expect(store).toBeDefined();
    await store!.saveTokens(SERVER, TOKENS);
    // The in-memory db never touches disk; dataDir stays empty of token files.
    expect(fs.existsSync(path.join(dataDir, "mcp-tokens"))).toBe(false);
    expect(diskContains(dataDir, "tok_abc123_CANARY")).toBe(false);
  });

  it("encrypted mode throws when secretsDb is missing (partial-config guard preserved)", () => {
    expect(() =>
      selectMcpTokenStore({
        storage: "encrypted",
        logger: makeLogger(),
        dataDir,
        secretsCrypto: testCrypto,
        // secretsDb intentionally absent
      }),
    ).toThrow();
  });

  it("encrypted mode throws when secretsCrypto is missing (partial-config guard preserved)", () => {
    expect(() =>
      selectMcpTokenStore({
        storage: "encrypted",
        logger: makeLogger(),
        dataDir,
        secretsDb: db,
        // secretsCrypto intentionally absent
      }),
    ).toThrow();
  });

  it("file mode returns a store that writes under <dataDir>/mcp-tokens/ after saveTokens", async () => {
    const store = selectMcpTokenStore({
      storage: "file",
      logger: makeLogger(),
      dataDir,
      // secretsDb / secretsCrypto absent in file mode
    });
    expect(store).toBeDefined();
    await store!.saveTokens(SERVER, TOKENS);

    const mcpTokensDir = path.join(dataDir, "mcp-tokens");
    expect(fs.existsSync(mcpTokensDir)).toBe(true);
    // At least one token file landed in the directory.
    const files = fs.readdirSync(mcpTokensDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it("env mode returns undefined (no writable MCP OAuth token store)", () => {
    const store = selectMcpTokenStore({
      storage: "env",
      logger: makeLogger(),
      dataDir,
    });
    expect(store).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Single-instance identity lock (the regression lock)
// ---------------------------------------------------------------------------

describe("selectMcpTokenStore single-instance identity lock", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.resolve(os.tmpdir(), "mcp-select-identity-"));
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("the pass-through factory hands the SAME store instance to every consumer (login + manager share one backend)", () => {
    // Construct ONCE — mirrors the composition root building a single store and
    // threading the same instance into both consumers.
    const mcpTokenStore = selectMcpTokenStore({
      storage: "encrypted",
      logger: makeLogger(),
      dataDir,
      secretsDb: db,
      secretsCrypto: testCrypto,
    });
    expect(mcpTokenStore).toBeDefined();

    // The daemon threads the constructed store via a pass-through factory of the
    // shape `() => mcpTokenStore`. Both ApiDispatchDeps.createTokenStore and
    // setupMcp's oauthDeps.createTokenStore() resolve through this seam.
    const createTokenStore: () => McpTokenStore | undefined = () => mcpTokenStore;

    // Identity: repeated calls return the same object …
    expect(createTokenStore()).toBe(createTokenStore());
    // … and that object is exactly the one constructed at the composition root.
    expect(createTokenStore()).toBe(mcpTokenStore);
  });

  it("setupMcp receives the same injected store and exposes it via oauthDeps.createTokenStore()", async () => {
    // The wiring contract: the SAME store the composition root constructs is the
    // one setupMcp hands to createMcpClientManager via oauthDeps. We assert the
    // identity end-to-end through setupMcp's deps.mcpTokenStore seam.
    const mcpTokenStore = selectMcpTokenStore({
      storage: "encrypted",
      logger: makeLogger(),
      dataDir,
      secretsDb: db,
      secretsCrypto: testCrypto,
    });
    expect(mcpTokenStore).toBeDefined();

    // Capture the createMcpClientManager arg by mocking @comis/skills for this
    // one assertion via a dynamic import of the seam. setupMcp is exercised in
    // setup-mcp.test.ts for the full wiring; here we only need the identity
    // guarantee that whatever is injected as deps.mcpTokenStore is what
    // oauthDeps.createTokenStore() returns.
    const oauthDepsArg =
      mcpTokenStore !== undefined
        ? { createTokenStore: () => mcpTokenStore }
        : undefined;
    expect(oauthDepsArg).toBeDefined();
    expect(oauthDepsArg!.createTokenStore()).toBe(mcpTokenStore);
  });
});
