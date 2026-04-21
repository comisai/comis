// SPDX-License-Identifier: Apache-2.0
/**
 * Identity link store for cross-platform user recognition.
 *
 * Maps multiple provider identities (e.g., Discord user, Telegram user)
 * to a single canonical identity using SQLite-backed CRUD operations.
 *
 * Factory function pattern (createIdentityLinkStore) consistent with
 * createSessionStore for minimal public surface area.
 */

import type Database from "better-sqlite3";

/**
 * A single identity link mapping a provider identity to a canonical ID.
 */
export interface IdentityLink {
  canonicalId: string;
  provider: string;
  providerUserId: string;
  displayName?: string;
  linkedAt: number;
}

/**
 * IdentityLinkStore provides CRUD operations for cross-platform identity links.
 *
 * All operations are synchronous (better-sqlite3 is synchronous).
 * Links are keyed by (provider, provider_user_id) composite primary key.
 */
export interface IdentityLinkStore {
  /** Create or update an identity link. On conflict, updates canonical_id, display_name, linked_at. */
  link(canonicalId: string, provider: string, providerUserId: string, displayName?: string): void;
  /** Remove an identity link. Returns true if a row was deleted, false if not found. */
  unlink(provider: string, providerUserId: string): boolean;
  /** Resolve the canonical ID for a provider identity. Returns undefined if not linked. */
  resolve(provider: string, providerUserId: string): string | undefined;
  /** List all identity links for a canonical ID, ordered by linked_at DESC. */
  listByCanonical(canonicalId: string): IdentityLink[];
  /** List all identity links, ordered by canonical_id then provider. */
  listAll(): IdentityLink[];
}

/** Raw row shape from the identity_links table. */
interface IdentityLinkRow {
  canonical_id: string;
  provider: string;
  provider_user_id: string;
  display_name: string | null;
  linked_at: number;
}

/** Map a raw DB row to the public IdentityLink interface. */
function mapRow(row: IdentityLinkRow): IdentityLink {
  return {
    canonicalId: row.canonical_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    displayName: row.display_name ?? undefined,
    linkedAt: row.linked_at,
  };
}

/**
 * Create an IdentityLinkStore bound to the given database.
 *
 * Assumes `initSchema()` has already been called on the database
 * to create the `identity_links` table.
 */
export function createIdentityLinkStore(db: Database.Database): IdentityLinkStore {
  // Prepare statements once for performance
  const upsertStmt = db.prepare(`
    INSERT INTO identity_links (canonical_id, provider, provider_user_id, display_name, linked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET
      canonical_id = excluded.canonical_id,
      display_name = excluded.display_name,
      linked_at = excluded.linked_at
  `);

  const resolveStmt = db.prepare(
    "SELECT canonical_id FROM identity_links WHERE provider = ? AND provider_user_id = ?",
  );

  const listByCanonicalStmt = db.prepare(
    "SELECT * FROM identity_links WHERE canonical_id = ? ORDER BY linked_at DESC",
  );

  const listAllStmt = db.prepare(
    "SELECT * FROM identity_links ORDER BY canonical_id, provider",
  );

  const unlinkStmt = db.prepare(
    "DELETE FROM identity_links WHERE provider = ? AND provider_user_id = ?",
  );

  return {
    link(canonicalId: string, provider: string, providerUserId: string, displayName?: string): void {
      const now = Date.now();
      upsertStmt.run(canonicalId, provider, providerUserId, displayName ?? null, now);
    },

    unlink(provider: string, providerUserId: string): boolean {
      const result = unlinkStmt.run(provider, providerUserId);
      return result.changes > 0;
    },

    resolve(provider: string, providerUserId: string): string | undefined {
      const row = resolveStmt.get(provider, providerUserId) as
        | { canonical_id: string }
        | undefined;
      return row?.canonical_id;
    },

    listByCanonical(canonicalId: string): IdentityLink[] {
      const rows = listByCanonicalStmt.all(canonicalId) as IdentityLinkRow[];
      return rows.map(mapRow);
    },

    listAll(): IdentityLink[] {
      const rows = listAllStmt.all() as IdentityLinkRow[];
      return rows.map(mapRow);
    },
  };
}
