// SPDX-License-Identifier: Apache-2.0
/**
 * Embedding provider fingerprint manager.
 *
 * Stores a hash of the embedding provider's modelId and dimensions
 * in the `embedding_provider_meta` SQLite table. On startup, the
 * daemon compares the current provider's fingerprint with the stored
 * one to detect model or dimension changes that would corrupt vector
 * search results.
 */

import type { EmbeddingPort } from "@comis/core";
import type Database from "better-sqlite3";
import { computeEmbeddingIdentityHash } from "./embedding-hash.js";

export interface ProviderFingerprint {
  modelId: string;
  dimensions: number;
  hash: string;
}

export interface FingerprintManager {
  /** Create the embedding_provider_meta table if it doesn't exist. */
  ensureTable(): void;

  /** Get the currently stored fingerprint, or null if none saved yet. */
  getCurrent(): ProviderFingerprint | null;

  /** Save a fingerprint (overwrites any previous fingerprint). */
  save(fp: ProviderFingerprint): void;

  /** Check whether the given provider's fingerprint differs from stored. */
  hasChanged(provider: EmbeddingPort): boolean;

  /** Compute a fingerprint from an EmbeddingPort's metadata. */
  computeFingerprint(provider: EmbeddingPort): ProviderFingerprint;
}

/**
 * Create a FingerprintManager backed by the given SQLite database.
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns A FingerprintManager for reading/writing provider fingerprints
 */
export function createFingerprintManager(db: Database.Database): FingerprintManager {
  const manager: FingerprintManager = {
    ensureTable(): void {
      // Canonical DDL is in schema.ts:initSchema(). This CREATE TABLE IF NOT EXISTS
      // is a safety net for callers that invoke ensureTable() before initSchema()
      // (e.g., setup-memory.ts). Harmless no-op when the table already exists.
      db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_provider_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    },

    getCurrent(): ProviderFingerprint | null {
      const modelRow = db
        .prepare("SELECT value FROM embedding_provider_meta WHERE key = ?")
        .get("model_id") as { value: string } | undefined;

      const dimsRow = db
        .prepare("SELECT value FROM embedding_provider_meta WHERE key = ?")
        .get("dimensions") as { value: string } | undefined;

      const hashRow = db
        .prepare("SELECT value FROM embedding_provider_meta WHERE key = ?")
        .get("fingerprint_hash") as { value: string } | undefined;

      if (!modelRow || !dimsRow || !hashRow) return null;

      return {
        modelId: modelRow.value,
        dimensions: Number(dimsRow.value),
        hash: hashRow.value,
      };
    },

    save(fp: ProviderFingerprint): void {
      const upsert = db.prepare(
        "INSERT OR REPLACE INTO embedding_provider_meta (key, value) VALUES (?, ?)",
      );

      const tx = db.transaction(() => {
        upsert.run("model_id", fp.modelId);
        upsert.run("dimensions", String(fp.dimensions));
        upsert.run("fingerprint_hash", fp.hash);
      });
      tx();
    },

    hasChanged(provider: EmbeddingPort): boolean {
      const stored = manager.getCurrent();
      // First run = no stored fingerprint = no change
      if (!stored) return false;

      const current = manager.computeFingerprint(provider);
      return current.hash !== stored.hash;
    },

    computeFingerprint(provider: EmbeddingPort): ProviderFingerprint {
      return {
        modelId: provider.modelId,
        dimensions: provider.dimensions,
        hash: computeEmbeddingIdentityHash(provider.modelId, provider.dimensions),
      };
    },
  };

  return manager;
}
