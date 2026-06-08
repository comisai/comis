// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-time inactive-backend credential probe.
 *
 * Called from daemon.ts bootShutdown() after emitStartupInvariants.
 * Probes the INACTIVE credential store (encrypted-side when activeMode is
 * file/env; file-side when activeMode is encrypted) and emits a WARN for
 * each credential family that holds real data the operator cannot reach.
 *
 * Invariants:
 *  - Never throws — all I/O is wrapped in try/catch.
 *  - Never logs credential values — only counts and store names.
 *  - All file paths go through safePath() (no path.join).
 *  - Canary-only secrets.db emits no WARN (count excludes __comis_canary__).
 *
 * @module
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// CANARY_NAME from packages/memory/src/secret-store-schema.ts:21
const CANARY_NAME = "__comis_canary__";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface StorageMismatchDeps {
  logger: ComisLogger;
  activeMode: "encrypted" | "file" | "env";
  dataDir: string;
  /** Pre-opened secrets.db handle — if supplied, used directly (file/env mode). */
  secretsDb?: import("better-sqlite3").Database;
}

/**
 * The closed set of stranded-credential families this probe can report.
 * Mirrors the `stranded:` labels already attached to each WARN payload — a
 * closed label set (never an open string), so the structured finding stays
 * §2.8-compliant.
 */
export type StrandedLabel =
  | "encrypted:secrets"
  | "encrypted:oauth_profiles"
  | "encrypted:mcp_credentials"
  | "file:secrets"
  | "file:oauth_profiles"
  | "file:mcp_tokens";

/** A single stranded-credential finding: a closed label + a COUNT (never a value). */
export interface StrandedFinding {
  stranded: StrandedLabel;
  entryCount: number;
}

/**
 * The structured result of the probe. Additive to the existing WARN side-effect
 * (one probe, two sinks): the I3 boot snapshot records these COUNTS into the
 * `config_posture` row — never a secret value.
 */
export interface StorageMismatchResult {
  findings: StrandedFinding[];
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Probe the inactive credential backend at boot and emit WARN for each
 * credential family that holds real entries the operator cannot reach in
 * the current activeMode.
 *
 * ADDITIVELY returns the structured `{ findings }` it WARNs with (counts +
 * closed labels only, NEVER secret values) so the boot `config_posture`
 * snapshot can record the stranded-secret COUNTS without re-probing — one
 * probe, two sinks (DRY). The WARN side-effect is unchanged.
 *
 * Pure, synchronous, never throws.
 */
export function checkStorageModeConsistency(
  deps: StorageMismatchDeps,
): StorageMismatchResult {
  const { logger, activeMode, dataDir } = deps;

  if (activeMode === "file" || activeMode === "env") {
    return { findings: probeEncryptedSide(logger, activeMode, dataDir, deps.secretsDb) };
  }
  // activeMode === "encrypted": probe file-side for stranded files
  return { findings: probeFileSide(logger, dataDir) };
}

// ---------------------------------------------------------------------------
// Internal: probe encrypted-side (secrets.db tables)
// ---------------------------------------------------------------------------

function probeEncryptedSide(
  logger: ComisLogger,
  activeMode: "file" | "env",
  dataDir: string,
  secretsDb: import("better-sqlite3").Database | undefined,
): StrandedFinding[] {
  // If a pre-opened handle is provided, use it directly (no file-existence check needed).
  if (secretsDb !== undefined) {
    return querySecretsDbTables(logger, activeMode, secretsDb);
  }

  // No pre-opened handle: check if the file exists before attempting to open.
  const dbPath = safePath(dataDir, "secrets.db");
  if (!existsSync(dbPath)) {
    return []; // No encrypted db → nothing stranded
  }

  // File exists but no handle provided — attempt to open read-only.
  let db: import("better-sqlite3").Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    return querySecretsDbTables(logger, activeMode, db);
  } catch (e) {
    logger.warn(
      {
        errorKind: "config" as const,
        hint: "Inspect secrets.db manually or remove it if it is corrupt.",
        err: e,
      },
      "Could not probe inactive encrypted store — skipping mismatch check",
    );
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

/**
 * Run the three table-count queries against an already-open secrets.db handle.
 * Emits a WARN per non-empty family AND returns the matching count-only
 * findings (the same `{stranded, entryCount}` objects the WARNs carry).
 */
function querySecretsDbTables(
  logger: ComisLogger,
  activeMode: "file" | "env",
  db: import("better-sqlite3").Database,
): StrandedFinding[] {
  const findings: StrandedFinding[] = [];

  // Secrets table (exclude canary)
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM secrets WHERE name != ?`)
      .get(CANARY_NAME) as { n: number };
    if (row.n > 0) {
      logger.warn(
        {
          errorKind: "config" as const,
          hint:
            `The encrypted secrets store (secrets.db) has ${row.n} real secret(s) but ` +
            `security.storage is "${activeMode}". They are not reachable in ${activeMode} mode. ` +
            `Manual step: export each entry from secrets.db (comis secrets list --mode encrypted), ` +
            `re-add via comis secrets set, then remove secrets.db — ` +
            `or switch security.storage back to "encrypted". ` +
            `Cross-mode migration tooling is planned for a future milestone.`,
          stranded: "encrypted:secrets",
          entryCount: row.n,
        },
        "Inactive encrypted secrets store has real credentials — they are not reachable in file/env mode",
      );
      findings.push({ stranded: "encrypted:secrets", entryCount: row.n });
    }
  } catch {
    /* table may not exist yet — treat as empty */
  }

  // OAuth profiles table
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM oauth_profiles`)
      .get() as { n: number };
    if (row.n > 0) {
      logger.warn(
        {
          errorKind: "config" as const,
          hint:
            `The encrypted OAuth profile store (oauth_profiles) has ${row.n} profile(s) but ` +
            `security.storage is "${activeMode}". They are not reachable in ${activeMode} mode. ` +
            `Manual step: re-run comis auth login after switching to the correct mode, ` +
            `or set security.storage: encrypted. ` +
            `Cross-mode migration tooling is planned for a future milestone.`,
          stranded: "encrypted:oauth_profiles",
          entryCount: row.n,
        },
        "Inactive encrypted OAuth profile store has real profiles — they are not reachable in file/env mode",
      );
      findings.push({ stranded: "encrypted:oauth_profiles", entryCount: row.n });
    }
  } catch {
    /* table may not exist yet */
  }

  // MCP credentials table
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM mcp_credentials`)
      .get() as { n: number };
    if (row.n > 0) {
      logger.warn(
        {
          errorKind: "config" as const,
          hint:
            `The encrypted MCP credential store (mcp_credentials) has ${row.n} entry/entries but ` +
            `security.storage is "${activeMode}". They are not reachable in ${activeMode} mode. ` +
            `Manual step: re-run mcp_login for each server after switching to the correct mode, ` +
            `or set security.storage: encrypted.`,
          stranded: "encrypted:mcp_credentials",
          entryCount: row.n,
        },
        "Inactive encrypted MCP credential store has real credentials — they are not reachable in file/env mode",
      );
      findings.push({ stranded: "encrypted:mcp_credentials", entryCount: row.n });
    }
  } catch {
    /* table may not exist yet */
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Internal: probe file-side (secrets.json / auth-profiles.json / mcp-tokens/)
// ---------------------------------------------------------------------------

function probeFileSide(logger: ComisLogger, dataDir: string): StrandedFinding[] {
  const findings: StrandedFinding[] = [];

  // secrets.json
  const secretsJsonPath = safePath(dataDir, "secrets.json");
  if (existsSync(secretsJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(secretsJsonPath, "utf-8")) as {
        schemaVersion?: number;
        secrets?: Record<string, unknown>;
      };
      const count = Object.keys(raw.secrets ?? {}).length;
      if (count > 0) {
        logger.warn(
          {
            errorKind: "config" as const,
            hint:
              `secrets.json has ${count} secret(s) but security.storage is "encrypted". ` +
              `They are not reachable in encrypted mode. ` +
              `Manual step: re-add each entry via comis secrets set (they will persist to secrets.db), ` +
              `then remove secrets.json — or switch security.storage to "file". ` +
              `Cross-mode migration tooling is planned for a future milestone.`,
            stranded: "file:secrets",
            entryCount: count,
          },
          "Inactive file secret store has real secrets — they are not reachable in encrypted mode",
        );
        findings.push({ stranded: "file:secrets", entryCount: count });
      }
    } catch {
      /* corrupt JSON — treat as empty */
    }
  }

  // auth-profiles.json
  const authProfilesPath = safePath(dataDir, "auth-profiles.json");
  if (existsSync(authProfilesPath)) {
    try {
      const raw = JSON.parse(readFileSync(authProfilesPath, "utf-8")) as {
        profiles?: unknown[] | Record<string, unknown>;
      };
      // Support both array and object shapes
      const profiles = raw.profiles;
      const count = Array.isArray(profiles)
        ? profiles.length
        : profiles != null
          ? Object.keys(profiles).length
          : 0;
      if (count > 0) {
        logger.warn(
          {
            errorKind: "config" as const,
            hint:
              `auth-profiles.json has ${count} OAuth profile(s) but security.storage is "encrypted". ` +
              `They are not reachable in encrypted mode. ` +
              `Manual step: re-run comis auth login in encrypted mode, or switch security.storage to "file".`,
            stranded: "file:oauth_profiles",
            entryCount: count,
          },
          "Inactive file OAuth profile store has real profiles — they are not reachable in encrypted mode",
        );
        findings.push({ stranded: "file:oauth_profiles", entryCount: count });
      }
    } catch {
      /* corrupt JSON */
    }
  }

  // mcp-tokens/
  const mcpTokensDir = safePath(dataDir, "mcp-tokens");
  if (existsSync(mcpTokensDir)) {
    try {
      const count = (readdirSync(mcpTokensDir) as unknown as string[]).filter((f) =>
        f.endsWith(".json"),
      ).length;
      if (count > 0) {
        logger.warn(
          {
            errorKind: "config" as const,
            hint:
              `mcp-tokens/ has ${count} token file(s) but security.storage is "encrypted". ` +
              `They are not reachable in encrypted mode. ` +
              `Manual step: re-run mcp_login for each server in encrypted mode, ` +
              `or switch security.storage to "file".`,
            stranded: "file:mcp_tokens",
            entryCount: count,
          },
          "Inactive file MCP token store has real tokens — they are not reachable in encrypted mode",
        );
        findings.push({ stranded: "file:mcp_tokens", entryCount: count });
      }
    } catch {
      /* unreadable dir */
    }
  }

  return findings;
}
