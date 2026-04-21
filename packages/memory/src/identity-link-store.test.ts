// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema } from "./schema.js";
import {
  createIdentityLinkStore,
  type IdentityLinkStore,
} from "./identity-link-store.js";

describe("createIdentityLinkStore", () => {
  let db: Database.Database;
  let store: IdentityLinkStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 128);
    store = createIdentityLinkStore(db);
  });

  it("link creates a new identity link, resolve returns the canonical ID", () => {
    store.link("canonical-1", "discord", "discord-user-42");

    const result = store.resolve("discord", "discord-user-42");
    expect(result).toBe("canonical-1");
  });

  it("link with same provider+providerUserId but different canonicalId updates (upsert)", () => {
    store.link("canonical-1", "telegram", "tg-user-7");
    store.link("canonical-2", "telegram", "tg-user-7");

    const result = store.resolve("telegram", "tg-user-7");
    expect(result).toBe("canonical-2");
  });

  it("unlink removes existing link and returns true", () => {
    store.link("canonical-1", "discord", "discord-user-42");

    const removed = store.unlink("discord", "discord-user-42");
    expect(removed).toBe(true);

    const result = store.resolve("discord", "discord-user-42");
    expect(result).toBeUndefined();
  });

  it("unlink returns false for non-existent link", () => {
    const removed = store.unlink("discord", "nonexistent-user");
    expect(removed).toBe(false);
  });

  it("resolve returns undefined for unlinked provider identity", () => {
    const result = store.resolve("slack", "unknown-user");
    expect(result).toBeUndefined();
  });

  it("listByCanonical returns all links for a canonical ID", () => {
    store.link("canonical-1", "discord", "discord-user-42");
    store.link("canonical-1", "telegram", "tg-user-7");
    store.link("canonical-2", "slack", "slack-user-99");

    const links = store.listByCanonical("canonical-1");
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.provider).sort()).toEqual(["discord", "telegram"]);
    expect(links.every((l) => l.canonicalId === "canonical-1")).toBe(true);
  });

  it("listAll returns all links sorted by canonical_id, provider", () => {
    store.link("canonical-2", "slack", "slack-user-99");
    store.link("canonical-1", "telegram", "tg-user-7");
    store.link("canonical-1", "discord", "discord-user-42");

    const links = store.listAll();
    expect(links).toHaveLength(3);
    // Sorted by canonical_id then provider
    expect(links[0]!.canonicalId).toBe("canonical-1");
    expect(links[0]!.provider).toBe("discord");
    expect(links[1]!.canonicalId).toBe("canonical-1");
    expect(links[1]!.provider).toBe("telegram");
    expect(links[2]!.canonicalId).toBe("canonical-2");
    expect(links[2]!.provider).toBe("slack");
  });

  it("link with displayName stores and retrieves it", () => {
    store.link("canonical-1", "discord", "discord-user-42", "CoolUser#1234");

    const links = store.listByCanonical("canonical-1");
    expect(links).toHaveLength(1);
    expect(links[0]!.displayName).toBe("CoolUser#1234");
  });

  it("link without displayName stores undefined", () => {
    store.link("canonical-1", "discord", "discord-user-42");

    const links = store.listByCanonical("canonical-1");
    expect(links).toHaveLength(1);
    expect(links[0]!.displayName).toBeUndefined();
  });

  it("listByCanonical returns links ordered by linked_at DESC", () => {
    // Insert with explicit timestamps for deterministic ordering
    db.prepare(
      `INSERT INTO identity_links (canonical_id, provider, provider_user_id, display_name, linked_at)
       VALUES ('c1', 'discord', 'u1', NULL, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO identity_links (canonical_id, provider, provider_user_id, display_name, linked_at)
       VALUES ('c1', 'telegram', 'u2', NULL, 3000)`,
    ).run();
    db.prepare(
      `INSERT INTO identity_links (canonical_id, provider, provider_user_id, display_name, linked_at)
       VALUES ('c1', 'slack', 'u3', NULL, 2000)`,
    ).run();

    const links = store.listByCanonical("c1");
    expect(links).toHaveLength(3);
    expect(links[0]!.provider).toBe("telegram"); // linked_at 3000
    expect(links[1]!.provider).toBe("slack"); // linked_at 2000
    expect(links[2]!.provider).toBe("discord"); // linked_at 1000
  });
});
