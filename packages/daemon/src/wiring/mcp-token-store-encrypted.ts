// SPDX-License-Identifier: Apache-2.0
// @allow-throw: server-name validation (precondition) + encrypt/decrypt error propagation
/**
 * Encrypted SQLite-backed TokenStore implementation for MCP OAuth credentials.
 *
 * Stores all three MCP OAuth artifacts (tokens, clientInformation, discoveryState)
 * as AES-256-GCM blobs in the `mcp_credentials` table in secrets.db.
 *
 * Key design invariants:
 * - Does NOT own the db lifecycle (mirrors createOAuthProfileStoreEncrypted).
 *   close() is a no-op — the db handle is never closed here.
 * - Writes zero plaintext files; no mcp-tokens/ directory is ever created.
 * - client_secret is inside the encrypted JSON blob — never written plaintext.
 * - expires_at stores absolute epoch-ms; tokens() reconstructs relative expires_in.
 * - startWatch() is a no-op (no chokidar — no disk presence).
 * - Row validation via createRowMapper / Zod — no untyped casts.
 *
 * @module
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import type { SecretsCrypto, EncryptedSecret } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { createRowMapper } from "@comis/memory";
import type { TokenStore } from "@comis/skills";
import type { OAuthTokens, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel TTL for tokens with no expires_in: ~10 years in seconds. */
const SENTINEL_TTL_SEC = 10 * 365 * 24 * 60 * 60;

/** Regex for valid MCP server names — prevents SQL injection via parameterised key. */
const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Server-name validation (precondition guard — @allow-throw)
// ---------------------------------------------------------------------------

function assertServerName(server: string): void {
  if (typeof server !== "string" || !MCP_SERVER_NAME_RE.test(server)) {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(server)}`);
  }
}

// ---------------------------------------------------------------------------
// Row schema + mapper
// ---------------------------------------------------------------------------

const McpCredRowSchema = z.strictObject({
  server: z.string(),
  artifact: z.enum(["tokens", "client", "discovery"]),
  ciphertext: z.instanceof(Buffer),
  iv: z.instanceof(Buffer),
  auth_tag: z.instanceof(Buffer),
  salt: z.instanceof(Buffer),
  expires_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const mcpCredMapper = createRowMapper(McpCredRowSchema);

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

function initMcpCredSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_credentials (
      server      TEXT    NOT NULL,
      artifact    TEXT    NOT NULL CHECK(artifact IN ('tokens','client','discovery')),
      ciphertext  BLOB    NOT NULL,
      iv          BLOB    NOT NULL,
      auth_tag    BLOB    NOT NULL,
      salt        BLOB    NOT NULL,
      expires_at  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (server, artifact)
    )
  `);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully encrypted TokenStore backed by the `mcp_credentials` table
 * in the shared secrets.db.
 *
 * The caller supplies the pre-opened db handle and SecretsCrypto instance.
 * This factory does NOT open or close the database.
 */
export function createMcpTokenStoreEncrypted(
  db: Database.Database,
  crypto: SecretsCrypto,
): TokenStore {
  initMcpCredSchema(db);

  // Prepared statements — compiled once at construction time.
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO mcp_credentials
      (server, artifact, ciphertext, iv, auth_tag, salt, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getStmt = db.prepare(
    "SELECT * FROM mcp_credentials WHERE server = ? AND artifact = ?",
  );

  const deleteAllStmt = db.prepare(
    "DELETE FROM mcp_credentials WHERE server = ?",
  );

  // ---- Internal helpers --------------------------------------------------

  function encryptAndUpsert(
    server: string,
    artifact: "tokens" | "client" | "discovery",
    payload: string,
    expiresAt: number | null,
  ): void {
    const encResult = crypto.encrypt(payload);
    if (!encResult.ok) throw encResult.error;
    const { ciphertext, iv, authTag, salt } = encResult.value;
    const now = systemNowMs();
    upsertStmt.run(server, artifact, ciphertext, iv, authTag, salt, expiresAt, now, now);
  }

  function getDecryptedRow(
    server: string,
    artifact: "tokens" | "client" | "discovery",
  ): string | undefined {
    const raw = getStmt.get(server, artifact);
    const parsed = mcpCredMapper.parseOptionalRow(raw);
    if (!parsed.ok) {
      throw new Error(`mcp_credentials row validation failed: ${parsed.error.message}`);
    }
    const row = parsed.value;
    if (!row) return undefined;

    const encrypted: EncryptedSecret = {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag, // SQL column auth_tag → TS field authTag
      salt: row.salt,
    };
    const decResult = crypto.decrypt(encrypted);
    if (!decResult.ok) throw decResult.error;
    return decResult.value;
  }

  // ---- TokenStore implementation ----------------------------------------

  return {
    async tokens(server: string): Promise<OAuthTokens | undefined> {
      assertServerName(server);
      const jsonStr = getDecryptedRow(server, "tokens");
      if (jsonStr === undefined) return undefined;

      const raw = JSON.parse(jsonStr) as OAuthTokens & { expires_in?: number };
      const row = getStmt.get(server, "tokens") as { expires_at: number | null } | undefined;

      let expiresIn: number | undefined;
      if (row?.expires_at !== null && row?.expires_at !== undefined) {
        expiresIn = Math.max(0, Math.floor((row.expires_at - systemNowMs()) / 1000));
      }

      const result: OAuthTokens = {
        access_token: raw.access_token,
        token_type: raw.token_type,
        ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
        ...(raw.refresh_token !== undefined ? { refresh_token: raw.refresh_token } : {}),
        ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
      };
      return result;
    },

    async saveTokens(server: string, sdkTokens: OAuthTokens): Promise<void> {
      assertServerName(server);
      const ttlSec = sdkTokens.expires_in ?? SENTINEL_TTL_SEC;
      const expiresAt = systemNowMs() + ttlSec * 1000;
      const payload = JSON.stringify(sdkTokens);
      encryptAndUpsert(server, "tokens", payload, expiresAt);
    },

    async clientInformation(
      server: string,
    ): Promise<OAuthClientInformationFull | undefined> {
      assertServerName(server);
      const jsonStr = getDecryptedRow(server, "client");
      if (jsonStr === undefined) return undefined;
      return JSON.parse(jsonStr) as OAuthClientInformationFull;
    },

    async saveClientInformation(
      server: string,
      info: OAuthClientInformationFull,
    ): Promise<void> {
      assertServerName(server);
      // Encrypt the entire SDK object as a JSON blob — client_secret stays inside the blob.
      const payload = JSON.stringify(info);
      encryptAndUpsert(server, "client", payload, null);
    },

    async discoveryState(server: string): Promise<OAuthDiscoveryState | undefined> {
      assertServerName(server);
      const jsonStr = getDecryptedRow(server, "discovery");
      if (jsonStr === undefined) return undefined;
      return JSON.parse(jsonStr) as OAuthDiscoveryState;
    },

    async saveDiscoveryState(
      server: string,
      state: OAuthDiscoveryState,
    ): Promise<void> {
      assertServerName(server);
      const payload = JSON.stringify(state);
      encryptAndUpsert(server, "discovery", payload, null);
    },

    async deleteAll(server: string): Promise<void> {
      assertServerName(server);
      deleteAllStmt.run(server);
    },

    startWatch(): Promise<void> {
      // No-op — no disk presence, no chokidar watch.
      return Promise.resolve();
    },

    close(): Promise<void> {
      // No-op — does NOT own the db lifecycle. The caller (selectSecretStore)
      // closes the shared secretsDb handle.
      return Promise.resolve();
    },
  };
}
