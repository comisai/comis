// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { searchByText, searchByVector } from "./hybrid-search.js";
import { initSchema } from "./schema.js";
import type { ConversationRef, MemoryRecallScope } from "@comis/core";

const scope: MemoryRecallScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  conversationRef: "cv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as ConversationRef,
  principalId: "principal_a",
  includeAgentShared: true,
};

describe("memory recall statement scoping", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4);
  });

  it("candidate statements constrain allowed visibility lanes before ranking", () => {
    const insertPartition = db.prepare(
      "INSERT INTO memory_authority_partitions (tenant_id, agent_id, visibility_key) VALUES (?, ?, ?)",
    );
    insertPartition.run(scope.tenantId, scope.agentId, `conversation:${scope.conversationRef}`);
    insertPartition.run(scope.tenantId, scope.agentId, `principal:${scope.principalId}`);
    insertPartition.run(scope.tenantId, scope.agentId, "agent-shared");
    const prepared: string[] = [];
    const callsBySql = new Map<string, unknown[][]>();
    const wrapped = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          prepared.push(sql);
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "all") {
                const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...params: unknown[]) => {
                const calls = callsBySql.get(sql) ?? [];
                calls.push(params);
                callsBySql.set(sql, calls);
                return statement.all(...params);
              };
            },
          });
        };
      },
    });

    searchByText(wrapped, "orchid", 3, scope);

    const candidateIndex = prepared.findIndex((sql) => sql.includes("memory_fts MATCH"));
    expect(candidateIndex).toBeGreaterThanOrEqual(0);
    const candidateSql = prepared[candidateIndex]!;
    expect(candidateSql).toMatch(/MATCH[\s\S]*ORDER BY[\s\S]*LIMIT/);
    const match = callsBySql.get(candidateSql)?.[0]?.[0];
    expect(match).toMatch(/authority_token/);
    expect(match).toMatch(/authority_\d+.*OR.*authority_\d+.*OR.*authority_\d+/);
    expect(prepared.some((sql) => /tenant_id\s*=\s*\?.*agent_id\s*=\s*\?/s.test(sql))).toBe(true);
  });

  it("knn candidate statements carry the tenant-agent partition inside the vec0 query", () => {
    db.prepare(
      "INSERT INTO memory_authority_partitions (tenant_id, agent_id, visibility_key) VALUES (?, ?, ?)",
    ).run(scope.tenantId, scope.agentId, `conversation:${scope.conversationRef}`);
    const prepared: string[] = [];
    const wrapped = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          prepared.push(sql);
          return target.prepare(sql);
        };
      },
    });

    searchByVector(wrapped, [1, 0, 0, 0], 3, scope);

    const knn = prepared.find((sql) => sql.includes("embedding MATCH"));
    expect(knn).toMatch(/authority_partition_id\s*=\s*\?/);
    expect(knn).toMatch(/embedding MATCH[\s\S]*authority_partition_id[\s\S]*(?:k\s*=|LIMIT)/);
  });
});
