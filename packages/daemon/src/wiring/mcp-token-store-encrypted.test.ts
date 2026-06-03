// SPDX-License-Identifier: Apache-2.0
/**
 * RED test suite for `createMcpTokenStoreEncrypted`.
 *
 * This file imports from `./mcp-token-store-encrypted.js` which does NOT exist
 * yet — that is the expected RED state (vitest fails at runtime with
 * "Cannot find module"). `*.test.ts` is excluded from
 * `packages/daemon/tsconfig.json` so `pnpm build` stays clean.
 *
 * Coverage groups:
 *   1. Schema — mcp_credentials table created on init
 *   2. tokens round-trip (saveTokens → tokens)
 *   3. clientInformation round-trip (saveClientInformation → clientInformation)
 *   4. discoveryState round-trip (saveDiscoveryState → discoveryState)
 *   5. deleteAll — removes all 3 artifact rows
 *   6. refresh-rotation — saveTokens twice, second set wins
 *   7. residency — no plaintext on disk, no mcp-tokens dir
 *   8. startWatch is a no-op
 *   9. close does NOT close the db handle
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSecretsCrypto } from "@comis/core";
import type { OAuthTokens, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpTokenStoreEncrypted } from "./mcp-token-store-encrypted.js";

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

const CLIENT_INFO: OAuthClientInformationFull = {
  client_id: "client_abc",
  client_secret: "secret_SUPERSENSITIVE_CANARY",
  redirect_uris: [new URL("https://example.com/cb")],
};

const DISCOVERY: OAuthDiscoveryState = {
  authorizationServerUrl: "https://auth.example.com",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk `dir` recursively and return true if any file's binary content
 * contains the UTF-8 bytes of `needle`. Does NOT log file content.
 */
function diskContains(dir: string, needle: string): boolean {
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
// Group 1 — Schema
// ---------------------------------------------------------------------------

describe("createMcpTokenStoreEncrypted schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("mcp_credentials table exists in secrets.db after createMcpTokenStoreEncrypted", () => {
    createMcpTokenStoreEncrypted(db, testCrypto);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_credentials'")
      .get() as { name: string } | undefined;
    expect(row).toEqual({ name: "mcp_credentials" });
  });

  it("createMcpTokenStoreEncrypted is idempotent — calling twice does not throw", () => {
    expect(() => {
      createMcpTokenStoreEncrypted(db, testCrypto);
      createMcpTokenStoreEncrypted(db, testCrypto);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 2 — tokens round-trip
// ---------------------------------------------------------------------------

describe("tokens round-trip (saveTokens → tokens)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("saveTokens then tokens() returns access_token, token_type, refresh_token, scope", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    const result = await store.tokens(SERVER);
    expect(result).toBeDefined();
    expect(result?.access_token).toBe("tok_abc123_CANARY");
    expect(result?.token_type).toBe("Bearer");
    expect(result?.refresh_token).toBe("ref_xyz789_CANARY");
    expect(result?.scope).toBe("openid profile");
  });

  it("tokens() returns undefined for an unknown server name", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const result = await store.tokens("unknown-server");
    expect(result).toBeUndefined();
  });

  it("saveTokens converts relative expires_in to absolute epoch-ms and tokens() reconstructs a plausible expires_in back", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const before = Date.now();
    await store.saveTokens(SERVER, TOKENS); // expires_in: 3600
    const result = await store.tokens(SERVER);
    const after = Date.now();
    expect(result?.expires_in).toBeDefined();
    // Reconstructed expires_in (seconds) must be plausibly ~3600
    // (some ms may have passed, so allow a generous window: 3590–3600)
    expect(result!.expires_in).toBeGreaterThan(0);
    expect(result!.expires_in).toBeLessThanOrEqual(3600);
    expect(result!.expires_in).toBeGreaterThanOrEqual(3590);
    // Raw expires_at stored in DB must be an absolute epoch-ms value
    // well above any relative-seconds interpretation
    const row = db
      .prepare("SELECT expires_at FROM mcp_credentials WHERE server=? AND artifact='tokens'")
      .get(SERVER) as { expires_at: number } | undefined;
    expect(row?.expires_at).toBeGreaterThan(before + 3590_000);
    expect(row?.expires_at).toBeLessThanOrEqual(after + 3600_000 + 100);
  });

  it("saveTokens without expires_in persists a long-horizon sentinel expires_at", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const tokensNoExpiry: OAuthTokens = { access_token: "tok_no_expiry", token_type: "Bearer" };
    await store.saveTokens(SERVER, tokensNoExpiry);
    const row = db
      .prepare("SELECT expires_at FROM mcp_credentials WHERE server=? AND artifact='tokens'")
      .get(SERVER) as { expires_at: number } | undefined;
    // Sentinel TTL ~10 years in ms
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(row?.expires_at).toBeGreaterThan(Date.now() + tenYearsMs - 60_000);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — clientInformation round-trip
// ---------------------------------------------------------------------------

describe("clientInformation round-trip (saveClientInformation → clientInformation)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("saveClientInformation then clientInformation() returns client_id and client_secret preserved", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.saveClientInformation(SERVER, CLIENT_INFO);
    const result = await store.clientInformation(SERVER);
    expect(result).toBeDefined();
    expect(result?.client_id).toBe("client_abc");
    expect(result?.client_secret).toBe("secret_SUPERSENSITIVE_CANARY");
  });

  it("clientInformation() returns undefined for an unknown server name", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const result = await store.clientInformation("unknown-server");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 4 — discoveryState round-trip
// ---------------------------------------------------------------------------

describe("discoveryState round-trip (saveDiscoveryState → discoveryState)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("saveDiscoveryState then discoveryState() returns authorizationServerUrl preserved", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.saveDiscoveryState(SERVER, DISCOVERY);
    const result = await store.discoveryState(SERVER);
    expect(result).toBeDefined();
    expect(result?.authorizationServerUrl).toBe("https://auth.example.com");
  });

  it("discoveryState() returns undefined for an unknown server name", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const result = await store.discoveryState("unknown-server");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 5 — deleteAll
// ---------------------------------------------------------------------------

describe("deleteAll removes all 3 artifact rows for the server", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("deleteAll removes tokens, clientInformation, and discoveryState rows; subsequent reads return undefined", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    await store.saveClientInformation(SERVER, CLIENT_INFO);
    await store.saveDiscoveryState(SERVER, DISCOVERY);

    await store.deleteAll(SERVER);

    const [t, c, d] = await Promise.all([
      store.tokens(SERVER),
      store.clientInformation(SERVER),
      store.discoveryState(SERVER),
    ]);
    expect(t).toBeUndefined();
    expect(c).toBeUndefined();
    expect(d).toBeUndefined();
  });

  it("deleteAll for a server with no rows does not throw", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await expect(store.deleteAll("nonexistent-server")).resolves.not.toThrow();
  });

  it("deleteAll only removes rows for the specified server, not other servers", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const otherServer = "other-server";
    await store.saveTokens(SERVER, TOKENS);
    await store.saveTokens(otherServer, TOKENS);

    await store.deleteAll(SERVER);

    const mine = await store.tokens(SERVER);
    const theirs = await store.tokens(otherServer);
    expect(mine).toBeUndefined();
    expect(theirs).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Group 6 — refresh-rotation (saveTokens twice → second set wins)
// ---------------------------------------------------------------------------

describe("refresh-rotation (saveTokens twice overwrites, not appends)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("calling saveTokens twice with different tokens returns the second token set", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const first: OAuthTokens = { access_token: "first_tok", token_type: "Bearer", expires_in: 3600 };
    const second: OAuthTokens = { access_token: "second_tok", token_type: "Bearer", expires_in: 7200 };

    await store.saveTokens(SERVER, first);
    await store.saveTokens(SERVER, second);

    const result = await store.tokens(SERVER);
    expect(result?.access_token).toBe("second_tok");
  });

  it("refresh-rotation: mcp_credentials table has exactly one token row per server after two saves", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    await store.saveTokens(SERVER, { ...TOKENS, access_token: "new_tok" });

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM mcp_credentials WHERE server=? AND artifact='tokens'")
      .get(SERVER) as { cnt: number };
    expect(rows.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 7 — residency: no plaintext on disk, no mcp-tokens dir
// ---------------------------------------------------------------------------

describe("residency — no plaintext on disk, no mcp-tokens dir created", () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.resolve(os.tmpdir(), "mcp-enc-test-"));
    db = new Database(":memory:");
  });

  it("after all 3 saves: testDir does NOT contain a subdirectory named 'mcp-tokens'", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    await store.saveClientInformation(SERVER, CLIENT_INFO);
    await store.saveDiscoveryState(SERVER, DISCOVERY);

    const mcpTokensDir = path.join(testDir, "mcp-tokens");
    expect(fs.existsSync(mcpTokensDir)).toBe(false);
  });

  it("after all 3 saves: testDir does NOT contain plaintext access_token bytes", async () => {
    // Write the DB file into testDir so we can scan it too
    const dbPath = path.join(testDir, "secrets.db");
    const fileDb = new Database(dbPath);
    const store = createMcpTokenStoreEncrypted(fileDb, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    await store.saveClientInformation(SERVER, CLIENT_INFO);
    await store.saveDiscoveryState(SERVER, DISCOVERY);
    fileDb.close();

    expect(diskContains(testDir, "tok_abc123_CANARY")).toBe(false);
  });

  it("after all 3 saves: testDir does NOT contain plaintext client_secret bytes", async () => {
    const dbPath = path.join(testDir, "secrets.db");
    const fileDb = new Database(dbPath);
    const store = createMcpTokenStoreEncrypted(fileDb, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    await store.saveClientInformation(SERVER, CLIENT_INFO);
    await store.saveDiscoveryState(SERVER, DISCOVERY);
    fileDb.close();

    expect(diskContains(testDir, "secret_SUPERSENSITIVE_CANARY")).toBe(false);
  });

  it("after all 3 saves: testDir does NOT contain plaintext refresh_token bytes", async () => {
    const dbPath = path.join(testDir, "secrets.db");
    const fileDb = new Database(dbPath);
    const store = createMcpTokenStoreEncrypted(fileDb, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    await store.saveClientInformation(SERVER, CLIENT_INFO);
    await store.saveDiscoveryState(SERVER, DISCOVERY);
    fileDb.close();

    expect(diskContains(testDir, "ref_xyz789_CANARY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 8 — startWatch is a no-op
// ---------------------------------------------------------------------------

describe("startWatch is a no-op in the encrypted store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("startWatch() resolves without throwing and returns undefined", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await expect(store.startWatch()).resolves.toBeUndefined();
  });

  it("calling startWatch() twice does not throw", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await expect(
      store.startWatch().then(() => store.startWatch()),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 9 — close does NOT close the db handle
// ---------------------------------------------------------------------------

describe("close() does NOT close the shared secretsDb handle", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("after close(), db.open is still true (handle still open)", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.close();
    expect(db.open).toBe(true);
  });

  it("after close(), db can still be queried (reads succeed)", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await store.saveTokens(SERVER, TOKENS);
    await store.close();
    // db still open — should not throw
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM mcp_credentials")
      .get() as { cnt: number };
    expect(row.cnt).toBeGreaterThan(0);
  });

  it("close() resolves without throwing", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    await expect(store.close()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 10 — decrypt-failure rejects
// ---------------------------------------------------------------------------

describe("Group 10 — decrypt-failure rejects, does not return garbage", () => {
  it("tokens() rejects when the row was encrypted with a different key", async () => {
    const otherCrypto = createSecretsCrypto(Buffer.alloc(32, 0xff));
    const db = new Database(":memory:");
    const writer = createMcpTokenStoreEncrypted(db, otherCrypto);
    await writer.saveTokens(SERVER, TOKENS);

    const reader = createMcpTokenStoreEncrypted(db, testCrypto);
    await expect(reader.tokens(SERVER)).rejects.toThrow();
  });

  it("clientInformation() rejects when the row was encrypted with a different key", async () => {
    const otherCrypto = createSecretsCrypto(Buffer.alloc(32, 0xff));
    const db = new Database(":memory:");
    const writer = createMcpTokenStoreEncrypted(db, otherCrypto);
    await writer.saveClientInformation(SERVER, CLIENT_INFO);

    const reader = createMcpTokenStoreEncrypted(db, testCrypto);
    await expect(reader.clientInformation(SERVER)).rejects.toThrow();
  });

  it("discoveryState() rejects when the row was encrypted with a different key", async () => {
    const otherCrypto = createSecretsCrypto(Buffer.alloc(32, 0xff));
    const db = new Database(":memory:");
    const writer = createMcpTokenStoreEncrypted(db, otherCrypto);
    await writer.saveDiscoveryState(SERVER, DISCOVERY);

    const reader = createMcpTokenStoreEncrypted(db, testCrypto);
    await expect(reader.discoveryState(SERVER)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 11 — created_at preserved on rotation (regression guard)
// ---------------------------------------------------------------------------

describe("Group 11 — created_at preserved on token rotation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("saveTokens twice: created_at from first write is preserved, updated_at advances", async () => {
    const store = createMcpTokenStoreEncrypted(db, testCrypto);
    const first: OAuthTokens = { access_token: "first_tok", token_type: "Bearer", expires_in: 3600 };
    const second: OAuthTokens = { access_token: "second_tok", token_type: "Bearer", expires_in: 7200 };

    await store.saveTokens(SERVER, first);
    const rowAfterFirst = db
      .prepare("SELECT created_at, updated_at FROM mcp_credentials WHERE server=? AND artifact='tokens'")
      .get(SERVER) as { created_at: number; updated_at: number };
    const createdAtOriginal = rowAfterFirst.created_at;

    // Small pause to ensure updated_at can differ (system clock resolution)
    await new Promise((resolve) => setTimeout(resolve, 10));

    await store.saveTokens(SERVER, second);
    const rowAfterSecond = db
      .prepare("SELECT created_at, updated_at FROM mcp_credentials WHERE server=? AND artifact='tokens'")
      .get(SERVER) as { created_at: number; updated_at: number };

    // created_at must be preserved from the original insert
    expect(rowAfterSecond.created_at).toBe(createdAtOriginal);
    // updated_at must be >= original created_at (advanced or equal)
    expect(rowAfterSecond.updated_at).toBeGreaterThanOrEqual(createdAtOriginal);
  });
});
