/**
 * Tests for CredentialMappingStore — CredentialMappingPort implementation
 * with SQLite CRUD operations.
 *
 * Uses in-memory SQLite databases with foreign_keys enabled.
 * Each test gets a fresh database with the secrets table and a dummy secret.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Result } from "@comis/shared";
import type { CredentialMapping } from "@comis/core";
import { initSecretSchema } from "./secret-store-schema.js";
import { createCredentialMappingStore } from "./credential-mapping-store.js";

/** Unwrap a Result or fail the test. */
function unwrap<T>(result: Result<T, Error>): T {
  if (!result.ok) {
    throw new Error(`Expected ok result, got error: ${result.error.message}`);
  }
  return result.value;
}

/** Insert a dummy secret into the secrets table (needed for foreign key). */
function insertDummySecret(db: Database.Database, name: string): void {
  db.prepare(
    "INSERT INTO secrets (name, ciphertext, iv, auth_tag, salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(name, Buffer.from("c"), Buffer.from("i"), Buffer.from("a"), Buffer.from("s"), Date.now(), Date.now());
}

describe("createCredentialMappingStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSecretSchema(db);
    insertDummySecret(db, "OPENAI_API_KEY");
    insertDummySecret(db, "BRAVE_API_KEY");
  });

  describe("set + get roundtrip", () => {
    it("stores and retrieves a bearer_header mapping", () => {
      const store = createCredentialMappingStore(db);

      const mapping: CredentialMapping = {
        id: "map-001",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/*",
      };

      const setResult = store.set(mapping);
      expect(setResult.ok).toBe(true);

      const retrieved = unwrap(store.get("map-001"));
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("map-001");
      expect(retrieved!.secretName).toBe("OPENAI_API_KEY");
      expect(retrieved!.injectionType).toBe("bearer_header");
      expect(retrieved!.urlPattern).toBe("https://api.openai.com/*");
      expect(retrieved!.injectionKey).toBeUndefined();
      expect(retrieved!.toolName).toBeUndefined();
    });

    it("stores and retrieves a custom_header mapping with injectionKey", () => {
      const store = createCredentialMappingStore(db);

      const mapping: CredentialMapping = {
        id: "map-002",
        secretName: "BRAVE_API_KEY",
        injectionType: "custom_header",
        injectionKey: "X-Subscription-Token",
        urlPattern: "https://api.search.brave.com/*",
        toolName: "brave_search",
      };

      unwrap(store.set(mapping));

      const retrieved = unwrap(store.get("map-002"));
      expect(retrieved).toBeDefined();
      expect(retrieved!.injectionType).toBe("custom_header");
      expect(retrieved!.injectionKey).toBe("X-Subscription-Token");
      expect(retrieved!.toolName).toBe("brave_search");
    });

    it("stores and retrieves a query_param mapping with injectionKey", () => {
      const store = createCredentialMappingStore(db);

      const mapping: CredentialMapping = {
        id: "map-003",
        secretName: "OPENAI_API_KEY",
        injectionType: "query_param",
        injectionKey: "api_key",
        urlPattern: "https://api.example.com/*",
      };

      unwrap(store.set(mapping));

      const retrieved = unwrap(store.get("map-003"));
      expect(retrieved).toBeDefined();
      expect(retrieved!.injectionType).toBe("query_param");
      expect(retrieved!.injectionKey).toBe("api_key");
    });

    it("stores and retrieves a basic_auth mapping", () => {
      const store = createCredentialMappingStore(db);

      const mapping: CredentialMapping = {
        id: "map-004",
        secretName: "OPENAI_API_KEY",
        injectionType: "basic_auth",
        urlPattern: "https://internal.example.com/*",
      };

      unwrap(store.set(mapping));

      const retrieved = unwrap(store.get("map-004"));
      expect(retrieved).toBeDefined();
      expect(retrieved!.injectionType).toBe("basic_auth");
      expect(retrieved!.injectionKey).toBeUndefined();
    });
  });

  describe("get", () => {
    it("returns undefined for non-existent mapping", () => {
      const store = createCredentialMappingStore(db);

      const retrieved = unwrap(store.get("nonexistent"));
      expect(retrieved).toBeUndefined();
    });
  });

  describe("listAll", () => {
    it("returns all inserted mappings", () => {
      const store = createCredentialMappingStore(db);

      unwrap(store.set({
        id: "map-a",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/*",
      }));

      unwrap(store.set({
        id: "map-b",
        secretName: "BRAVE_API_KEY",
        injectionType: "custom_header",
        injectionKey: "X-Subscription-Token",
        urlPattern: "https://api.search.brave.com/*",
        toolName: "brave_search",
      }));

      const all = unwrap(store.listAll());
      expect(all).toHaveLength(2);
      const ids = all.map((m) => m.id).sort();
      expect(ids).toEqual(["map-a", "map-b"]);
    });

    it("returns empty array when no mappings exist", () => {
      const store = createCredentialMappingStore(db);

      const all = unwrap(store.listAll());
      expect(all).toEqual([]);
    });
  });

  describe("listBySecret", () => {
    it("filters by secret name", () => {
      const store = createCredentialMappingStore(db);

      unwrap(store.set({
        id: "map-a",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/*",
      }));

      unwrap(store.set({
        id: "map-b",
        secretName: "BRAVE_API_KEY",
        injectionType: "custom_header",
        injectionKey: "X-Subscription-Token",
        urlPattern: "https://api.search.brave.com/*",
      }));

      unwrap(store.set({
        id: "map-c",
        secretName: "OPENAI_API_KEY",
        injectionType: "query_param",
        injectionKey: "key",
        urlPattern: "https://other.openai.com/*",
      }));

      const openaiMappings = unwrap(store.listBySecret("OPENAI_API_KEY"));
      expect(openaiMappings).toHaveLength(2);
      expect(openaiMappings.every((m) => m.secretName === "OPENAI_API_KEY")).toBe(true);

      const braveMappings = unwrap(store.listBySecret("BRAVE_API_KEY"));
      expect(braveMappings).toHaveLength(1);
      expect(braveMappings[0].id).toBe("map-b");
    });

    it("returns empty array when no mappings match", () => {
      const store = createCredentialMappingStore(db);

      const result = unwrap(store.listBySecret("NONEXISTENT_KEY"));
      expect(result).toEqual([]);
    });
  });

  describe("listByTool", () => {
    it("filters by tool name (excludes null tool_name)", () => {
      const store = createCredentialMappingStore(db);

      unwrap(store.set({
        id: "map-a",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/*",
        // no toolName -- should NOT appear in listByTool results
      }));

      unwrap(store.set({
        id: "map-b",
        secretName: "BRAVE_API_KEY",
        injectionType: "custom_header",
        injectionKey: "X-Subscription-Token",
        urlPattern: "https://api.search.brave.com/*",
        toolName: "brave_search",
      }));

      unwrap(store.set({
        id: "map-c",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/v1/*",
        toolName: "brave_search",
      }));

      const braveMappings = unwrap(store.listByTool("brave_search"));
      expect(braveMappings).toHaveLength(2);
      expect(braveMappings.every((m) => m.toolName === "brave_search")).toBe(true);

      // Mapping without toolName should not appear
      const ids = braveMappings.map((m) => m.id);
      expect(ids).not.toContain("map-a");
    });

    it("returns empty array when no mappings match the tool", () => {
      const store = createCredentialMappingStore(db);

      const result = unwrap(store.listByTool("nonexistent_tool"));
      expect(result).toEqual([]);
    });
  });

  describe("delete", () => {
    it("returns true when mapping exists and is deleted", () => {
      const store = createCredentialMappingStore(db);

      unwrap(store.set({
        id: "map-to-delete",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/*",
      }));

      const deleted = unwrap(store.delete("map-to-delete"));
      expect(deleted).toBe(true);

      // Confirm deleted
      const retrieved = unwrap(store.get("map-to-delete"));
      expect(retrieved).toBeUndefined();
    });

    it("returns false when mapping does not exist", () => {
      const store = createCredentialMappingStore(db);

      const deleted = unwrap(store.delete("nonexistent"));
      expect(deleted).toBe(false);
    });
  });

  // ── urlPattern regex validation ───────────────────────────────────

  describe("urlPattern regex validation", () => {
    it("accepts valid regex pattern", () => {
      const store = createCredentialMappingStore(db);

      const result = store.set({
        id: "map-regex-valid",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api\\.example\\.com/.*",
      });

      expect(result.ok).toBe(true);
    });

    it("accepts broad wildcard pattern", () => {
      const store = createCredentialMappingStore(db);

      const result = store.set({
        id: "map-regex-broad",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: ".*",
      });

      expect(result.ok).toBe(true);
    });

    it("returns err for unclosed parenthesis", () => {
      const store = createCredentialMappingStore(db);

      const result = store.set({
        id: "map-regex-bad-paren",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "(unclosed",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid urlPattern");
        expect(result.error.message).toContain("(unclosed");
      }
    });

    it("returns err for unclosed bracket", () => {
      const store = createCredentialMappingStore(db);

      const result = store.set({
        id: "map-regex-bad-bracket",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "[invalid",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid urlPattern");
      }
    });
  });

  describe("upsert behavior", () => {
    it("updates existing mapping when same id is set twice", () => {
      const store = createCredentialMappingStore(db);

      unwrap(store.set({
        id: "map-upsert",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/v1/*",
      }));

      // Update with different values
      unwrap(store.set({
        id: "map-upsert",
        secretName: "BRAVE_API_KEY",
        injectionType: "custom_header",
        injectionKey: "X-Api-Key",
        urlPattern: "https://api.search.brave.com/*",
        toolName: "brave_search",
      }));

      const retrieved = unwrap(store.get("map-upsert"));
      expect(retrieved).toBeDefined();
      expect(retrieved!.secretName).toBe("BRAVE_API_KEY");
      expect(retrieved!.injectionType).toBe("custom_header");
      expect(retrieved!.injectionKey).toBe("X-Api-Key");
      expect(retrieved!.urlPattern).toBe("https://api.search.brave.com/*");
      expect(retrieved!.toolName).toBe("brave_search");

      // Should still be only one mapping
      const all = unwrap(store.listAll());
      expect(all).toHaveLength(1);
    });
  });

  describe("ON DELETE CASCADE", () => {
    it("deletes credential mappings when referenced secret is deleted", () => {
      const store = createCredentialMappingStore(db);

      unwrap(store.set({
        id: "map-cascade-1",
        secretName: "OPENAI_API_KEY",
        injectionType: "bearer_header",
        urlPattern: "https://api.openai.com/*",
      }));

      unwrap(store.set({
        id: "map-cascade-2",
        secretName: "OPENAI_API_KEY",
        injectionType: "query_param",
        injectionKey: "key",
        urlPattern: "https://other.openai.com/*",
      }));

      // Verify mappings exist
      const before = unwrap(store.listBySecret("OPENAI_API_KEY"));
      expect(before).toHaveLength(2);

      // Delete the referenced secret from the secrets table
      db.prepare("DELETE FROM secrets WHERE name = ?").run("OPENAI_API_KEY");

      // Mappings should be cascade-deleted
      const after = unwrap(store.listBySecret("OPENAI_API_KEY"));
      expect(after).toHaveLength(0);

      // Verify via get too
      const mapping1 = unwrap(store.get("map-cascade-1"));
      expect(mapping1).toBeUndefined();
      const mapping2 = unwrap(store.get("map-cascade-2"));
      expect(mapping2).toBeUndefined();
    });
  });
});
