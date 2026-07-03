// SPDX-License-Identifier: Apache-2.0
/**
 * RED tests for checkStorageModeConsistency.
 *
 * These tests fail with "Cannot find module './setup-storage-mismatch-warn.js'"
 * until the implementation is created. That failure IS the correct RED state.
 *
 * Test coverage:
 *   Group A — Encrypted mode active: probe file-side for stranded files
 *   Group B — File mode active: probe encrypted-side via secretsDb
 *   Group C — DoS guard: corrupt/locked db must not crash the function
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

// Mock node:fs so tests control file-existence/content.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

import * as mockFs from "node:fs";

import type { StorageMismatchDeps } from "./setup-storage-mismatch-warn.js";
import { checkStorageModeConsistency } from "./setup-storage-mismatch-warn.js";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mock logger that captures warn calls for assertions. */
function makeTestLogger(): {
  logger: ComisLogger;
  warnCalls: unknown[][];
} {
  const warnCalls: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => logger,
  } as unknown as ComisLogger;
  return { logger, warnCalls };
}

/**
 * Create an in-memory SQLite database with the secrets table pre-created,
 * matching the schema from secret-store-schema.ts.
 */
function createSecretsDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      salt BLOB NOT NULL,
      provider TEXT,
      description TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

/**
 * Insert a canary-only row into the secrets table.
 * name = '__comis_canary__' — must NOT count as a real credential.
 */
function insertCanaryRow(db: Database.Database): void {
  const buf = Buffer.alloc(16);
  db.prepare(
    `INSERT INTO secrets (name, ciphertext, iv, auth_tag, salt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("__comis_canary__", buf, buf, buf, buf, 1000, 1000);
}

/**
 * Insert a real (non-canary) secrets row.
 */
function insertRealSecretsRow(db: Database.Database, name = "MY_REAL_KEY"): void {
  const buf = Buffer.alloc(16);
  db.prepare(
    `INSERT INTO secrets (name, ciphertext, iv, auth_tag, salt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(name, buf, buf, buf, buf, 1000, 1000);
}

/** Reset all mock return values to defaults (no files, empty dirs). */
function resetMockFs(): void {
  vi.mocked(mockFs.existsSync).mockReturnValue(false);
  vi.mocked(mockFs.readFileSync as (...args: unknown[]) => unknown).mockReturnValue("{}");
  vi.mocked(mockFs.readdirSync as (...args: unknown[]) => unknown).mockReturnValue([]);
}

// ---------------------------------------------------------------------------
// Group A — Encrypted mode active: probe file-side for stranded credentials
// ---------------------------------------------------------------------------

describe("checkStorageModeConsistency", () => {
  beforeEach(() => {
    resetMockFs();
  });

  describe("Group A — encrypted mode: probe file-side for stranded credentials", () => {
    it("encrypted mode: secrets.json with real entries triggers WARN containing 'secrets.json'", () => {
      const { logger, warnCalls } = makeTestLogger();

      // secrets.json exists and has a real entry
      vi.mocked(mockFs.existsSync).mockImplementation((p: unknown) => {
        return String(p).endsWith("secrets.json");
      });
      vi.mocked(mockFs.readFileSync as (...args: unknown[]) => unknown).mockReturnValue(
        JSON.stringify({ schemaVersion: 1, secrets: { MY_KEY: { value: "secret", createdAt: 1000, updatedAt: 1000 } } }),
      );

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "encrypted",
        dataDir: "/home/test/.comis",
        secretsDb: undefined,
      };

      checkStorageModeConsistency(deps);

      expect(warnCalls.length).toBeGreaterThan(0);
      const allWarns = JSON.stringify(warnCalls);
      expect(allWarns).toContain("secrets.json");
    });

    it("encrypted mode: secrets.json with empty entries object does NOT warn for secrets", () => {
      const { logger, warnCalls } = makeTestLogger();

      vi.mocked(mockFs.existsSync).mockImplementation((p: unknown) => {
        return String(p).endsWith("secrets.json");
      });
      vi.mocked(mockFs.readFileSync as (...args: unknown[]) => unknown).mockReturnValue(
        JSON.stringify({ schemaVersion: 1, secrets: {} }),
      );

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "encrypted",
        dataDir: "/home/test/.comis",
        secretsDb: undefined,
      };

      checkStorageModeConsistency(deps);

      // No WARN for the secrets.json family when entries is empty
      const secretsJsonWarns = warnCalls.filter((call) => {
        return JSON.stringify(call).includes("secrets.json");
      });
      expect(secretsJsonWarns).toHaveLength(0);
    });

    it("encrypted mode: auth-profiles.json with one profile triggers WARN containing 'auth-profiles.json'", () => {
      const { logger, warnCalls } = makeTestLogger();

      vi.mocked(mockFs.existsSync).mockImplementation((p: unknown) => {
        return String(p).endsWith("auth-profiles.json");
      });
      vi.mocked(mockFs.readFileSync as (...args: unknown[]) => unknown).mockReturnValue(
        JSON.stringify({ version: 1, profiles: { p1: { profileId: "p1" } } }),
      );

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "encrypted",
        dataDir: "/home/test/.comis",
        secretsDb: undefined,
      };

      checkStorageModeConsistency(deps);

      expect(warnCalls.length).toBeGreaterThan(0);
      const allWarns = JSON.stringify(warnCalls);
      expect(allWarns).toContain("auth-profiles.json");
    });

    it("encrypted mode: mcp-tokens/ directory with one .json file triggers WARN containing 'mcp-tokens'", () => {
      const { logger, warnCalls } = makeTestLogger();

      vi.mocked(mockFs.existsSync).mockImplementation((p: unknown) => {
        return String(p).endsWith("mcp-tokens");
      });
      vi.mocked(mockFs.readdirSync as (...args: unknown[]) => unknown).mockReturnValue(
        ["server1.json"] as unknown as Buffer[],
      );

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "encrypted",
        dataDir: "/home/test/.comis",
        secretsDb: undefined,
      };

      checkStorageModeConsistency(deps);

      expect(warnCalls.length).toBeGreaterThan(0);
      const allWarns = JSON.stringify(warnCalls);
      expect(allWarns).toContain("mcp-tokens");
    });

    it("encrypted mode: all file-side stores empty or absent → no WARN emitted", () => {
      const { logger, warnCalls } = makeTestLogger();

      // All existsSync calls return false (no file-side artifacts exist)
      vi.mocked(mockFs.existsSync).mockReturnValue(false);

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "encrypted",
        dataDir: "/home/test/.comis",
        secretsDb: undefined,
      };

      checkStorageModeConsistency(deps);

      expect(warnCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Group B — File mode active: probe encrypted-side via secretsDb
  // ---------------------------------------------------------------------------

  describe("Group B — file mode: probe encrypted-side (secrets.db tables)", () => {
    it("file mode: secrets.db with real secrets row (not canary) triggers WARN with errorKind:'config' and hint containing 'security.storage'", () => {
      const { logger, warnCalls } = makeTestLogger();

      const db = createSecretsDb();
      insertCanaryRow(db);
      insertRealSecretsRow(db, "PRODUCTION_KEY");

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: db,
      };

      checkStorageModeConsistency(deps);

      db.close();

      expect(warnCalls.length).toBeGreaterThan(0);
      // The WARN must contain errorKind:"config" and hint with "security.storage"
      const firstWarnArg = warnCalls[0]?.[0] as Record<string, unknown>;
      expect(firstWarnArg).toMatchObject({ errorKind: "config" });
      const hintText = String(firstWarnArg?.["hint"] ?? "");
      expect(hintText).toContain("security.storage");
    });

    it("file mode: canary-only secrets.db does NOT trigger WARN for secrets table", () => {
      const { logger, warnCalls } = makeTestLogger();

      const db = createSecretsDb();
      insertCanaryRow(db); // Only the canary — real count must be 0

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: db,
      };

      checkStorageModeConsistency(deps);

      db.close();

      // No WARN for secrets family when only the canary exists
      const secretsWarns = warnCalls.filter((call) => {
        const str = JSON.stringify(call);
        return str.includes("secrets") && !str.includes("oauth") && !str.includes("mcp");
      });
      expect(secretsWarns).toHaveLength(0);
    });

    it("file mode: oauth_profiles row triggers WARN with hint containing 'security.storage'", () => {
      const { logger, warnCalls } = makeTestLogger();

      const db = createSecretsDb();
      // Create oauth_profiles table and insert a real row
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_profiles (
          profile_id TEXT PRIMARY KEY,
          data BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.prepare(
        `INSERT INTO oauth_profiles (profile_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run("profile-1", Buffer.alloc(32), 1000, 1000);

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: db,
      };

      checkStorageModeConsistency(deps);

      db.close();

      expect(warnCalls.length).toBeGreaterThan(0);
      const allWarns = JSON.stringify(warnCalls);
      // Must mention oauth family
      expect(allWarns).toMatch(/oauth_profiles|encrypted OAuth/i);
      // Must include security.storage in hint
      const firstWarnArg = warnCalls.find((call) => {
        return JSON.stringify(call).match(/oauth_profiles|encrypted OAuth/i);
      })?.[0] as Record<string, unknown>;
      const hintText = String(firstWarnArg?.["hint"] ?? "");
      expect(hintText).toContain("security.storage");
    });

    it("file mode: mcp_credentials row triggers WARN with errorKind:'config'", () => {
      const { logger, warnCalls } = makeTestLogger();

      const db = createSecretsDb();
      // Create mcp_credentials table and insert a real row
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_credentials (
          server_id TEXT PRIMARY KEY,
          token_data BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.prepare(
        `INSERT INTO mcp_credentials (server_id, token_data, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run("my-mcp-server", Buffer.alloc(32), 1000, 1000);

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: db,
      };

      checkStorageModeConsistency(deps);

      db.close();

      expect(warnCalls.length).toBeGreaterThan(0);
      const firstWarnArg = warnCalls[0]?.[0] as Record<string, unknown>;
      expect(firstWarnArg).toMatchObject({ errorKind: "config" });
    });

    it("file mode: canary-only secrets.db + empty/absent oauth and mcp tables → no WARN", () => {
      const { logger, warnCalls } = makeTestLogger();

      const db = createSecretsDb();
      insertCanaryRow(db);
      // Create the other tables but leave them empty
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_profiles (
          profile_id TEXT PRIMARY KEY,
          data BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_credentials (
          server_id TEXT PRIMARY KEY,
          token_data BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: db,
      };

      checkStorageModeConsistency(deps);

      db.close();

      expect(warnCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Group C — DoS guard: corrupt/locked db must not crash the function
  // ---------------------------------------------------------------------------

  describe("Group C — DoS guard: corrupt or inaccessible db must not throw", () => {
    it("file mode: corrupt/locked secrets.db logs 'could not probe' WARN and never throws", () => {
      const { logger, warnCalls } = makeTestLogger();

      // Pass a real but closed (thus effectively broken for queries) db handle.
      // We simulate "could not probe" by passing undefined secretsDb but making
      // existsSync return true for secrets.db path.
      vi.mocked(mockFs.existsSync).mockImplementation((p: unknown) => {
        return String(p).endsWith("secrets.db");
      });

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: undefined, // undefined forces the implementation to open its own handle
      };

      // Must NOT throw even if opening secrets.db fails
      expect(() => checkStorageModeConsistency(deps)).not.toThrow();

      // When opening fails, implementation should emit a WARN about "could not probe"
      const allWarns = JSON.stringify(warnCalls);
      expect(allWarns).toMatch(/could not probe|probe failed|could not open/i);
    });

    it("file mode: secretsDb undefined and secrets.db file exists → attempts open, catches error, emits WARN, never throws", () => {
      const { logger, warnCalls } = makeTestLogger();

      // Simulate: secrets.db file exists on disk but cannot be opened
      vi.mocked(mockFs.existsSync).mockImplementation((p: unknown) => {
        // secrets.db exists, but no real file exists at this path (in-memory mock)
        return String(p).endsWith("secrets.db");
      });

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: undefined,
      };

      // Must not throw even if open attempt fails
      expect(() => checkStorageModeConsistency(deps)).not.toThrow();

      // At minimum, must have emitted a WARN about the probe failure
      expect(warnCalls.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Group D — Structured findings return: the probe RETURNS its
  // stranded-secret COUNTS (additive — the WARNs are preserved) so the boot
  // config_posture snapshot records counts, never secret values.
  // ---------------------------------------------------------------------------

  describe("Group D — returns structured findings (counts only, additive)", () => {
    it("file mode: secrets.db with N real secrets returns findings [{ stranded:'encrypted:secrets', entryCount:N }] (RED: pre-patch returns void)", () => {
      const { logger, warnCalls } = makeTestLogger();

      const db = createSecretsDb();
      insertCanaryRow(db); // canary excluded from the count
      insertRealSecretsRow(db, "PRODUCTION_KEY_1");
      insertRealSecretsRow(db, "PRODUCTION_KEY_2");

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: db,
      };

      const result = checkStorageModeConsistency(deps);

      db.close();

      // The structured return: the 2 real secrets (canary excluded) as a count.
      expect(result.findings).toEqual([
        { stranded: "encrypted:secrets", entryCount: 2 },
      ]);

      // ADDITIVE: the existing WARN is still emitted (the refactor adds a return,
      // it does not remove the WARN — one probe, two sinks).
      expect(warnCalls.length).toBeGreaterThan(0);

      // SECURITY: no finding carries a secret value — only the closed label +
      // the count. (Assert no value-bearing key leaked into the findings.)
      const findingsJson = JSON.stringify(result.findings);
      expect(findingsJson).not.toContain("PRODUCTION_KEY_1");
      expect(findingsJson).not.toContain("PRODUCTION_KEY_2");
      for (const f of result.findings) {
        expect(Object.keys(f).sort()).toEqual(["entryCount", "stranded"]);
        expect(typeof f.entryCount).toBe("number");
      }
    });

    it("clean state (nothing stranded) returns { findings: [] }", () => {
      const { logger } = makeTestLogger();

      // No file-side artifacts (encrypted mode, all existsSync false).
      vi.mocked(mockFs.existsSync).mockReturnValue(false);

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "encrypted",
        dataDir: "/home/test/.comis",
        secretsDb: undefined,
      };

      const result = checkStorageModeConsistency(deps);

      expect(result.findings).toEqual([]);
    });

    it("file mode: secrets + oauth_profiles + mcp_credentials all stranded → three findings (counts only)", () => {
      const { logger } = makeTestLogger();

      const db = createSecretsDb();
      insertRealSecretsRow(db, "REAL_KEY");
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_profiles (
          profile_id TEXT PRIMARY KEY,
          data BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.prepare(
        `INSERT INTO oauth_profiles (profile_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run("profile-1", Buffer.alloc(32), 1000, 1000);
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_credentials (
          server_id TEXT PRIMARY KEY,
          token_data BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.prepare(
        `INSERT INTO mcp_credentials (server_id, token_data, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run("my-mcp-server", Buffer.alloc(32), 1000, 1000);

      const deps: StorageMismatchDeps = {
        logger,
        activeMode: "file",
        dataDir: "/home/test/.comis",
        secretsDb: db,
      };

      const result = checkStorageModeConsistency(deps);

      db.close();

      // All three credential families surface as count-only findings.
      expect(result.findings).toEqual(
        expect.arrayContaining([
          { stranded: "encrypted:secrets", entryCount: 1 },
          { stranded: "encrypted:oauth_profiles", entryCount: 1 },
          { stranded: "encrypted:mcp_credentials", entryCount: 1 },
        ]),
      );
      expect(result.findings).toHaveLength(3);
    });
  });
});
