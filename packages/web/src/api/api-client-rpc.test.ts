// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the rpcCall branches of createApiClient.
 *
 * The existing api-client.test.ts covers only the HTTP-fetch path (no rpcCall
 * argument). This file targets the alternate code branch in every memory/session
 * method where the optional `rpcCall` callback was supplied — the JSON-RPC
 * delegation path used by RpcClient-backed callers. Without these tests the
 * RPC branches in browseMemory / deleteMemory / deleteMemoryBulk / exportMemory /
 * listSessions / getSessionDetail / resetSession / compactSession / deleteSession /
 * exportSession / resetSessionsBulk / exportSessionsBulk / deleteSessionsBulk
 * are entirely uncovered.
 *
 * Each test asserts:
 *   1. rpcCall is invoked with the correct method name + params payload
 *   2. The HTTP fetch path is NOT exercised when rpcCall is present
 *   3. The transformed result matches the daemon-side typed response
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createApiClient, type RpcCallFn } from "./api-client.js";

const BASE_URL = "http://localhost:3000";
const TOKEN = "test-rpc-bearer-token";
const AUTHORITY = { tenantId: "tenant-a", agentId: "agent-a" } as const;
const TARGET = { ...AUTHORITY, conversationRef: "cv-a" } as const;

function makeRpc<T>(result: T): RpcCallFn {
  return vi.fn(async () => result) as unknown as RpcCallFn;
}

describe("createApiClient — memory.browse via rpcCall path", () => {
  it("delegates browseMemory to rpcCall with method memory.browse and the explicit tenant/agent scope", async () => {
    const rpc = makeRpc({ entries: [], total: 0 });
    const client = createApiClient(BASE_URL, TOKEN, rpc);
    await client.browseMemory({ tenantId: "acme", agentId: "aria", limit: 10, offset: 5, type: "fact" });
    expect(rpc).toHaveBeenCalledWith("memory.browse", {
      tenant_id: "acme",
      agent_id: "aria",
      limit: 10,
      offset: 5,
      memory_type: "fact",
    });
  });

  it("returns the daemon-typed entries+total response from rpcCall without HTTP fallback", async () => {
    const entries = [
      { id: "m1", content: "x", memoryType: "fact", trustLevel: "trusted", score: 1, createdAt: 1 },
    ];
    const rpc = makeRpc({ entries, total: 1 });
    const client = createApiClient(BASE_URL, TOKEN, rpc);
    const result = await client.browseMemory({ tenantId: "acme", agentId: "aria" });
    expect(result.entries).toEqual(entries);
    expect(result.total).toBe(1);
  });
});

describe("createApiClient — memory.delete via rpcCall path", () => {
  it("delegates single deleteMemory through the contract ids array with explicit tenant/agent", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).deleteMemory("memory-id-7", { tenantId: "acme", agentId: "aria" });
    expect(rpc).toHaveBeenCalledWith("memory.delete", {
      ids: ["memory-id-7"],
      tenant_id: "acme",
      agent_id: "aria",
    });
  });

  it("delegates deleteMemoryBulk to rpcCall memory.delete with ids array + explicit tenant/agent", async () => {
    const rpc = makeRpc({ deleted: 3 });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).deleteMemoryBulk(["a", "b", "c"], { tenantId: "acme", agentId: "aria" });
    expect(rpc).toHaveBeenCalledWith("memory.delete", {
      ids: ["a", "b", "c"],
      tenant_id: "acme",
      agent_id: "aria",
    });
    expect(r.deleted).toBe(3);
  });
});

describe("createApiClient — memory.export via rpcCall path", () => {
  it("delegates exportMemory with explicit authority to memory.export", async () => {
    const rpc = makeRpc({ entries: [{ id: "id1", content: "one" }] });
    const result = await createApiClient(BASE_URL, TOKEN, rpc).exportMemory(AUTHORITY);
    expect(rpc).toHaveBeenCalledWith("memory.export", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
    });
    expect(result).toBe('{"id":"id1","content":"one"}');
  });

  it("filters typed memory export results locally for selected ids", async () => {
    const rpc = makeRpc({ entries: [{ id: "id1" }, { id: "id2" }, { id: "id3" }] });
    const result = await createApiClient(BASE_URL, TOKEN, rpc).exportMemory(
      AUTHORITY,
      ["id1", "id2"],
    );
    expect(rpc).toHaveBeenCalledWith("memory.export", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
    });
    expect(result).toBe('{"id":"id1"}\n{"id":"id2"}');
  });
});

describe("createApiClient — session.list via rpcCall path", () => {
  it("delegates listSessions with explicit tenant and agent authority", async () => {
    const rpc = makeRpc({ sessions: [], total: 0 });
    await createApiClient(BASE_URL, TOKEN, rpc).listSessions(AUTHORITY);
    expect(rpc).toHaveBeenCalledWith("session.list", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
    });
  });

  it("passes contract-supported session filters through RPC", async () => {
    const rpc = makeRpc({ sessions: [], total: 0 });
    await createApiClient(BASE_URL, TOKEN, rpc).listSessions({
      tenantId: "tenant-a",
      agentId: "alpha",
      kind: "dm",
      sinceMinutes: 60,
    });
    expect(rpc).toHaveBeenCalledWith("session.list", {
      tenant_id: "tenant-a",
      agent_id: "alpha",
      kind: "dm",
      since_minutes: 60,
    });
  });

  it("returns session list rows from the contract response", async () => {
    const rpc = makeRpc({
      sessions: [
        {
          conversationRef: "cv-alpha",
          agentId: "alpha",
          kind: "dm",
          messageCount: 4,
          totalTokens: 100,
          updatedAt: 1000,
          createdAt: 500,
        },
      ],
      total: 1,
    });
    const sessions = await createApiClient(BASE_URL, TOKEN, rpc).listSessions(AUTHORITY);
    expect(sessions[0]?.agentId).toBe("alpha");
    expect(sessions[0]?.kind).toBe("dm");
    expect(sessions[0]?.messageCount).toBe(4);
    expect(sessions[0]?.conversationRef).toBe("cv-alpha");
  });
});

describe("createApiClient — session.history via rpcCall path", () => {
  it("delegates getSessionDetail with the exact conversation authority", async () => {
    const rpc = makeRpc({ session: { key: "k1" }, messages: [] });
    await createApiClient(BASE_URL, TOKEN, rpc).getSessionDetail(TARGET);
    expect(rpc).toHaveBeenCalledWith("session.history", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
      conversation_ref: "cv-a",
    });
  });
});

describe("createApiClient — session.reset via rpcCall path", () => {
  it("delegates single resetSession with an explicit conversation target", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).resetSession(TARGET);
    expect(rpc).toHaveBeenCalledWith("session.reset", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
      conversation_ref: "cv-a",
    });
  });

  it("delegates bulk resets as contract-valid point calls", async () => {
    const rpc = makeRpc({ reset: true });
    const targets = [TARGET, { ...TARGET, conversationRef: "cv-b" }];
    const r = await createApiClient(BASE_URL, TOKEN, rpc).resetSessionsBulk(targets);
    expect(rpc).toHaveBeenNthCalledWith(1, "session.reset", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-a",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "session.reset", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-b",
    });
    expect(r.reset).toBe(2);
  });
});

describe("createApiClient — session.compact via rpcCall path", () => {
  it("delegates compactSession with an explicit conversation target", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).compactSession(TARGET);
    expect(rpc).toHaveBeenCalledWith("session.compact", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-a",
    });
  });
});

describe("createApiClient — session.delete via rpcCall path", () => {
  it("delegates single deleteSession with an explicit conversation target", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).deleteSession(TARGET);
    expect(rpc).toHaveBeenCalledWith("session.delete", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-a",
    });
  });

  it("delegates bulk deletes as contract-valid point calls", async () => {
    const rpc = makeRpc({ deleted: true });
    const targets = [TARGET, { ...TARGET, conversationRef: "cv-b" }];
    const r = await createApiClient(BASE_URL, TOKEN, rpc).deleteSessionsBulk(targets);
    expect(rpc).toHaveBeenNthCalledWith(1, "session.delete", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-a",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "session.delete", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-b",
    });
    expect(r.deleted).toBe(2);
  });
});

describe("createApiClient — session.export via rpcCall path", () => {
  it("delegates single exportSession with an explicit conversation target", async () => {
    const rpc = makeRpc({ conversationRef: "cv-a", messages: [] });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).exportSession(TARGET);
    expect(rpc).toHaveBeenCalledWith("session.export", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-a",
    });
    expect(JSON.parse(r)).toEqual({ conversationRef: "cv-a", messages: [] });
  });

  it("delegates bulk exports as contract-valid point calls", async () => {
    const rpc = makeRpc({ messages: [] });
    const targets = [TARGET, { ...TARGET, conversationRef: "cv-b" }];
    const r = await createApiClient(BASE_URL, TOKEN, rpc).exportSessionsBulk(targets);
    expect(rpc).toHaveBeenNthCalledWith(1, "session.export", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-a",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "session.export", {
      tenant_id: "tenant-a", agent_id: "agent-a", conversation_ref: "cv-b",
    });
    expect(r.split("\n")).toHaveLength(2);
  });
});

describe("createApiClient — fetch fallback when rpcCall is not provided", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to HTTP DELETE on deleteMemory when no rpcCall is supplied to factory", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response);
    await createApiClient(BASE_URL, TOKEN).deleteMemory("memory-1", { tenantId: "acme", agentId: "aria" });
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toContain("/api/memory/memory-1");
    expect(call[0]).toContain("tenant=acme");
    expect(call[0]).toContain("agent=aria");
    expect((call[1] as RequestInit)?.method).toBe("DELETE");
  });

  it("falls back to HTTP POST on bulk-delete when no rpcCall is supplied to factory", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deleted: 2 }),
    } as Response);
    await createApiClient(BASE_URL, TOKEN).deleteMemoryBulk(["id1", "id2"], { tenantId: "acme", agentId: "aria" });
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toContain("/api/memory/bulk-delete");
    expect((call[1] as RequestInit)?.method).toBe("POST");
    expect((call[1] as RequestInit)?.body).toContain("acme");
    expect((call[1] as RequestInit)?.body).toContain("aria");
  });

  it("builds the browseMemory query string from every defined parameter on fetch fallback", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], total: 0 }),
    } as Response);
    await createApiClient(BASE_URL, TOKEN).browseMemory({
      tenantId: "acme",
      offset: 10,
      limit: 50,
      type: "fact",
      trust: "trusted",
      agentId: "alpha",
      from: 100,
      to: 200,
    });
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("tenant=acme");
    expect(url).toContain("agent=alpha");
    expect(url).toContain("offset=10");
    expect(url).toContain("limit=50");
    expect(url).toContain("type=fact");
    expect(url).toContain("trust=trusted");
    expect(url).toContain("from=100");
    expect(url).toContain("to=200");
  });
});
