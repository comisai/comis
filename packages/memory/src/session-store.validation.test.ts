// SPDX-License-Identifier: Apache-2.0
import {
  createConversationRef,
  type ConversationRef,
  type ConversationScope,
  type SessionStorePort,
} from "@comis/core";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "./schema.js";
import { createSessionStore } from "./session-store.js";

function makeScope(principalId = "user_a"): ConversationScope {
  return {
    tenantId: "tenant_a",
    agentId: "agent_a",
    partition: { kind: "principal", principalId },
  };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

function expectError(result: { ok: boolean; error?: { errorKind?: string } }, errorKind: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error?.errorKind).toBe(errorKind);
}

describe("session store validation boundaries", () => {
  let db: Database.Database;
  let store: SessionStorePort;
  let scope: ConversationScope;
  let reference: ConversationRef;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createSessionStore(db);
    scope = makeScope();
    reference = value(createConversationRef(scope));
  });

  it("rejects malformed conversation and query authorities", () => {
    expectError(store.save({ ...scope, tenantId: "" }, []), "validation");
    expectError(store.load({ ...scope, agentId: "" }), "validation");
    expectError(store.delete({ ...scope, tenantId: "" }), "validation");
    expectError(store.list({ tenantId: "", agentId: "agent_a" }), "validation");
    expectError(store.loadByRef({ tenantId: "tenant_a", agentId: "" }, reference), "validation");
    expectError(store.deleteByRef({ tenantId: "", agentId: "agent_a" }, reference), "validation");
    expectError(store.listDetailed({ tenantId: "tenant_a", agentId: "" }), "validation");
    expectError(store.deleteStale({ tenantId: "tenant_a", agentId: "" }, 100), "validation");
  });

  it("rejects malformed references and retention ages", () => {
    const malformed = "not-a-conversation-reference" as ConversationRef;
    expectError(store.loadByRef({ tenantId: "tenant_a", agentId: "agent_a" }, malformed), "validation");
    expectError(store.deleteByRef({ tenantId: "tenant_a", agentId: "agent_a" }, malformed), "validation");
    expectError(store.deleteStale({ tenantId: "tenant_a", agentId: "agent_a" }, -1), "validation");
    expectError(store.deleteStale({ tenantId: "tenant_a", agentId: "agent_a" }, Number.NaN), "validation");
  });

  it("reports successful and absent deletion by canonical reference", () => {
    expect(store.save(scope, []).ok).toBe(true);
    expect(value(store.deleteByRef({ tenantId: "tenant_a", agentId: "agent_a" }, reference))).toBe(true);
    expect(value(store.deleteByRef({ tenantId: "tenant_a", agentId: "agent_a" }, reference))).toBe(false);
  });

  it("detects a digest collision with a different stored canonical scope", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET canonical_scope = ? WHERE conversation_ref = ?")
      .run(JSON.stringify(makeScope("user_b")), reference);

    expectError(store.save(scope, []), "internal");
  });

  it("rejects an invalid existing row before a save can update it", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET created_at = ? WHERE conversation_ref = ?")
      .run("not-a-number", reference);

    expectError(store.save(scope, []), "internal");
  });

  it.each([
    ["invalid scope JSON", "canonical_scope", "{"],
    ["scope schema mismatch", "canonical_scope", "{}"],
    ["invalid message JSON", "messages", "{"],
    ["message schema mismatch", "messages", "{}"],
    ["invalid metadata JSON", "metadata", "{"],
    ["metadata schema mismatch", "metadata", "[]"],
  ])("rejects stored rows with %s", (_label, column, replacement) => {
    expect(store.save(scope, [{ role: "user" }], { source: "test" }).ok).toBe(true);
    db.prepare(`UPDATE sessions SET ${column} = ? WHERE conversation_ref = ?`)
      .run(replacement, reference);

    expectError(store.loadByRef({ tenantId: "tenant_a", agentId: "agent_a" }, reference), "internal");
  });

  it("rejects authority columns that disagree with canonical scope", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET tenant_id = ? WHERE conversation_ref = ?")
      .run("tenant_b", reference);

    expectError(store.loadByRef({ tenantId: "tenant_b", agentId: "agent_a" }, reference), "internal");
  });

  it("rejects a stored reference that disagrees with canonical scope", () => {
    expect(store.save(scope, []).ok).toBe(true);
    const otherReference = value(createConversationRef(makeScope("user_b")));
    db.prepare("UPDATE sessions SET conversation_ref = ? WHERE conversation_ref = ?")
      .run(otherReference, reference);

    expectError(store.loadByRef({ tenantId: "tenant_a", agentId: "agent_a" }, otherReference), "internal");
  });

  it("rejects a row whose scalar columns fail validation", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET created_at = ? WHERE conversation_ref = ?")
      .run("not-a-number", reference);

    expectError(store.loadByRef({ tenantId: "tenant_a", agentId: "agent_a" }, reference), "internal");
  });

  it("rejects corrupt canonical scope data while listing sessions", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET canonical_scope = ? WHERE conversation_ref = ?")
      .run("{", reference);

    expectError(store.list({ tenantId: "tenant_a", agentId: "agent_a" }), "internal");
  });

  it("rejects malformed conversation references while listing sessions", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET conversation_ref = ? WHERE conversation_ref = ?")
      .run("not-a-reference", reference);

    expectError(store.list({ tenantId: "tenant_a", agentId: "agent_a" }), "internal");
  });

  it("rejects mismatched references while listing sessions", () => {
    expect(store.save(scope, []).ok).toBe(true);
    const otherReference = value(createConversationRef(makeScope("user_b")));
    db.prepare("UPDATE sessions SET conversation_ref = ? WHERE conversation_ref = ?")
      .run(otherReference, reference);

    expectError(store.list({ tenantId: "tenant_a", agentId: "agent_a" }), "internal");
  });

  it("rejects corrupt payloads while listing detailed sessions", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET metadata = ? WHERE conversation_ref = ?")
      .run("[]", reference);

    expectError(store.listDetailed({ tenantId: "tenant_a", agentId: "agent_a" }), "internal");
  });

  it("propagates corrupt row errors through canonical deletion", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET metadata = ? WHERE conversation_ref = ?")
      .run("[]", reference);

    expectError(store.delete(scope), "internal");
  });

  it("propagates corrupt row errors through reference deletion", () => {
    expect(store.save(scope, []).ok).toBe(true);
    db.prepare("UPDATE sessions SET messages = ? WHERE conversation_ref = ?")
      .run("{}", reference);

    expectError(store.deleteByRef({ tenantId: "tenant_a", agentId: "agent_a" }, reference), "internal");
  });

  it("translates closed list database failures into resource errors", () => {
    db.close();

    expectError(store.list({ tenantId: "tenant_a", agentId: "agent_a" }), "resource");
  });

  it("translates closed point lookup database failures into resource errors", () => {
    db.close();

    expectError(store.loadByRef({ tenantId: "tenant_a", agentId: "agent_a" }, reference), "resource");
  });

  it("translates closed save database failures into resource errors", () => {
    db.close();

    expectError(store.save(scope, []), "resource");
  });

  it("translates closed canonical delete database failures into resource errors", () => {
    db.close();

    expectError(store.delete(scope), "resource");
  });

  it("translates closed reference delete database failures into resource errors", () => {
    db.close();

    expectError(store.deleteByRef({ tenantId: "tenant_a", agentId: "agent_a" }, reference), "resource");
  });

  it("translates closed detailed list database failures into resource errors", () => {
    db.close();

    expectError(store.listDetailed({ tenantId: "tenant_a", agentId: "agent_a" }), "resource");
  });
});
