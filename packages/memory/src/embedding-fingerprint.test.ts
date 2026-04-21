// SPDX-License-Identifier: Apache-2.0
import type { EmbeddingPort } from "@comis/core";
import { ok } from "@comis/shared";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFingerprintManager } from "./embedding-fingerprint.js";

/** Create a minimal mock EmbeddingPort with given modelId and dimensions. */
function stubProvider(modelId: string, dimensions: number): EmbeddingPort {
  return {
    provider: "test",
    modelId,
    dimensions,
    embed: vi.fn().mockResolvedValue(ok(new Array(dimensions).fill(0))),
    embedBatch: vi.fn().mockResolvedValue(ok([])),
  };
}

describe("createFingerprintManager", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    const mgr = createFingerprintManager(db);
    mgr.ensureTable();
  });

  it("getCurrent returns null before any save", () => {
    const mgr = createFingerprintManager(db);
    expect(mgr.getCurrent()).toBeNull();
  });

  it("getCurrent returns saved fingerprint after save", () => {
    const mgr = createFingerprintManager(db);
    const provider = stubProvider("text-embedding-3-small", 1536);
    const fp = mgr.computeFingerprint(provider);
    mgr.save(fp);

    const stored = mgr.getCurrent();
    expect(stored).not.toBeNull();
    expect(stored!.modelId).toBe("text-embedding-3-small");
    expect(stored!.dimensions).toBe(1536);
    expect(stored!.hash).toBe(fp.hash);
  });

  it("first run: hasChanged returns false (no stored fingerprint)", () => {
    const mgr = createFingerprintManager(db);
    const provider = stubProvider("text-embedding-3-small", 1536);

    // No fingerprint saved yet
    expect(mgr.hasChanged(provider)).toBe(false);
  });

  it("same provider: hasChanged returns false after save", () => {
    const mgr = createFingerprintManager(db);
    const provider = stubProvider("text-embedding-3-small", 1536);

    mgr.save(mgr.computeFingerprint(provider));
    expect(mgr.hasChanged(provider)).toBe(false);
  });

  it("changed model: hasChanged returns true", () => {
    const mgr = createFingerprintManager(db);
    const providerA = stubProvider("model-a", 768);
    const providerB = stubProvider("model-b", 768);

    mgr.save(mgr.computeFingerprint(providerA));
    expect(mgr.hasChanged(providerB)).toBe(true);
  });

  it("changed dimensions: hasChanged returns true", () => {
    const mgr = createFingerprintManager(db);
    const provider768 = stubProvider("text-embedding-3-small", 768);
    const provider1536 = stubProvider("text-embedding-3-small", 1536);

    mgr.save(mgr.computeFingerprint(provider768));
    expect(mgr.hasChanged(provider1536)).toBe(true);
  });

  it("computeFingerprint produces deterministic hash", () => {
    const mgr = createFingerprintManager(db);
    const provider = stubProvider("nomic-embed-text", 384);

    const fp1 = mgr.computeFingerprint(provider);
    const fp2 = mgr.computeFingerprint(provider);

    expect(fp1.hash).toBe(fp2.hash);
    expect(fp1.modelId).toBe("nomic-embed-text");
    expect(fp1.dimensions).toBe(384);
  });

  it("save overwrites previous fingerprint", () => {
    const mgr = createFingerprintManager(db);

    const providerA = stubProvider("model-a", 768);
    const providerB = stubProvider("model-b", 1536);

    mgr.save(mgr.computeFingerprint(providerA));
    expect(mgr.getCurrent()!.modelId).toBe("model-a");

    mgr.save(mgr.computeFingerprint(providerB));
    expect(mgr.getCurrent()!.modelId).toBe("model-b");
    expect(mgr.getCurrent()!.dimensions).toBe(1536);
  });

  it("ensureTable is idempotent (safe to call multiple times)", () => {
    const mgr = createFingerprintManager(db);
    // Already called once in beforeEach; calling again should not throw
    expect(() => mgr.ensureTable()).not.toThrow();
  });
});
