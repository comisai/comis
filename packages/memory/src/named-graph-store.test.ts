import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createNamedGraphStore } from "./named-graph-store.js";
import type { NamedGraphStore } from "./named-graph-store.js";

describe("NamedGraphStore", () => {
  let db: Database.Database;
  let store: NamedGraphStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createNamedGraphStore(db);
  });

  describe("save and load", () => {
    it("persists and retrieves a graph with all fields", () => {
      const nodes = [{ id: "n1", task: "summarize" }, { id: "n2", task: "review" }];
      const edges = [{ from: "n1", to: "n2" }];
      const settings = { onFailure: "halt" };

      const id = store.save({
        id: "g1",
        tenantId: "t1",
        agentId: "agent-a",
        label: "My Pipeline",
        nodes,
        edges,
        settings,
      });

      expect(id).toBe("g1");

      const loaded = store.load("g1", "t1");
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("g1");
      expect(loaded!.tenantId).toBe("t1");
      expect(loaded!.agentId).toBe("agent-a");
      expect(loaded!.label).toBe("My Pipeline");
      expect(loaded!.nodes).toEqual(nodes);
      expect(loaded!.edges).toEqual(edges);
      expect(loaded!.settings).toEqual(settings);
      expect(loaded!.createdAt).toBeGreaterThan(0);
      expect(loaded!.updatedAt).toBeGreaterThan(0);
    });

    it("returns undefined for non-existent id", () => {
      expect(store.load("nonexistent", "t1")).toBeUndefined();
    });

    it("returns undefined for wrong tenant", () => {
      store.save({
        id: "g1",
        tenantId: "t1",
        agentId: "agent-a",
        label: "Test",
        nodes: [],
        edges: [],
        settings: {},
      });

      expect(store.load("g1", "t2")).toBeUndefined();
    });
  });

  describe("save upsert", () => {
    it("updates label and data on conflict", () => {
      store.save({
        id: "g1",
        tenantId: "t1",
        agentId: "agent-a",
        label: "Original",
        nodes: [{ id: "n1" }],
        edges: [],
        settings: {},
      });

      store.save({
        id: "g1",
        tenantId: "t1",
        agentId: "agent-a",
        label: "Updated",
        nodes: [{ id: "n1" }, { id: "n2" }],
        edges: [{ from: "n1", to: "n2" }],
        settings: { mode: "strict" },
      });

      const loaded = store.load("g1", "t1");
      expect(loaded).toBeDefined();
      expect(loaded!.label).toBe("Updated");
      expect(loaded!.nodes).toHaveLength(2);
      expect(loaded!.edges).toHaveLength(1);
      expect(loaded!.settings).toEqual({ mode: "strict" });
    });
  });

  describe("list with pagination", () => {
    beforeEach(() => {
      for (let i = 1; i <= 3; i++) {
        store.save({
          id: `g${i}`,
          tenantId: "t1",
          agentId: "agent-a",
          label: `Pipeline ${i}`,
          nodes: Array.from({ length: i }, (_, j) => ({ id: `n${j}` })),
          edges: [],
          settings: {},
        });
      }
    });

    it("returns paginated results with total", () => {
      const result = store.list("t1", { limit: 2, offset: 0 });
      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(3);
    });

    it("respects offset", () => {
      const result = store.list("t1", { limit: 2, offset: 2 });
      expect(result.entries).toHaveLength(1);
      expect(result.total).toBe(3);
    });

    it("uses default limit and offset", () => {
      const result = store.list("t1");
      expect(result.entries).toHaveLength(3);
      expect(result.total).toBe(3);
    });
  });

  describe("list returns summaries", () => {
    it("includes id, label, nodeCount, createdAt, updatedAt", () => {
      store.save({
        id: "g1",
        tenantId: "t1",
        agentId: "agent-a",
        label: "Summary Test",
        nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }],
        edges: [],
        settings: {},
      });

      const result = store.list("t1");
      expect(result.entries).toHaveLength(1);

      const summary = result.entries[0]!;
      expect(summary.id).toBe("g1");
      expect(summary.label).toBe("Summary Test");
      expect(summary.nodeCount).toBe(3);
      expect(summary.createdAt).toBeGreaterThan(0);
      expect(summary.updatedAt).toBeGreaterThan(0);

      // Summaries should NOT contain full nodes/edges/settings
      expect((summary as unknown as Record<string, unknown>)["nodes"]).toBeUndefined();
      expect((summary as unknown as Record<string, unknown>)["edges"]).toBeUndefined();
      expect((summary as unknown as Record<string, unknown>)["settings"]).toBeUndefined();
    });
  });

  describe("softDelete", () => {
    it("makes graph invisible to load and list", () => {
      store.save({
        id: "g1",
        tenantId: "t1",
        agentId: "agent-a",
        label: "To Delete",
        nodes: [],
        edges: [],
        settings: {},
      });

      const deleted = store.softDelete("g1", "t1");
      expect(deleted).toBe(true);

      expect(store.load("g1", "t1")).toBeUndefined();

      const result = store.list("t1");
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("returns false for non-existent graph", () => {
      expect(store.softDelete("nonexistent", "t1")).toBe(false);
    });

    it("returns false for already deleted graph", () => {
      store.save({
        id: "g1",
        tenantId: "t1",
        agentId: "agent-a",
        label: "Test",
        nodes: [],
        edges: [],
        settings: {},
      });

      expect(store.softDelete("g1", "t1")).toBe(true);
      expect(store.softDelete("g1", "t1")).toBe(false);
    });
  });

  describe("tenant isolation", () => {
    it("scopes list results by tenant", () => {
      store.save({
        id: "g1",
        tenantId: "tenant-a",
        agentId: "agent-a",
        label: "Tenant A Pipeline",
        nodes: [{ id: "n1" }],
        edges: [],
        settings: {},
      });

      store.save({
        id: "g2",
        tenantId: "tenant-b",
        agentId: "agent-a",
        label: "Tenant B Pipeline",
        nodes: [{ id: "n1" }],
        edges: [],
        settings: {},
      });

      const resultA = store.list("tenant-a");
      expect(resultA.entries).toHaveLength(1);
      expect(resultA.entries[0]!.label).toBe("Tenant A Pipeline");

      const resultB = store.list("tenant-b");
      expect(resultB.entries).toHaveLength(1);
      expect(resultB.entries[0]!.label).toBe("Tenant B Pipeline");
    });
  });

  describe("corrupt JSON resilience", () => {
    it("returns fallback values for invalid JSON in columns", () => {
      // Manually insert a row with corrupt JSON
      db.prepare(`
        INSERT INTO named_graphs (id, tenant_id, agent_id, label, nodes, edges, settings, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("corrupt", "t1", "agent-a", "Corrupt Graph", "NOT_JSON", "{bad", "null_like", Date.now(), Date.now());

      const loaded = store.load("corrupt", "t1");
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("corrupt");
      expect(loaded!.label).toBe("Corrupt Graph");
      // Fallback: invalid JSON -> empty array for nodes/edges
      expect(loaded!.nodes).toEqual([]);
      expect(loaded!.edges).toEqual([]);
      // "null_like" is not valid JSON, should fallback to {}
      expect(loaded!.settings).toEqual({});
    });

    it("returns 0 nodeCount for corrupt JSON in list", () => {
      db.prepare(`
        INSERT INTO named_graphs (id, tenant_id, agent_id, label, nodes, edges, settings, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("corrupt2", "t1", "agent-a", "Bad Nodes", "NOT_ARRAY", "[]", "{}", Date.now(), Date.now());

      const result = store.list("t1");
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.nodeCount).toBe(0);
    });
  });
});
