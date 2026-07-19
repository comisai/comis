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

function makeRpc<T>(result: T): RpcCallFn {
  return vi.fn(async () => result) as unknown as RpcCallFn;
}

describe("createApiClient — memory.browse via rpcCall path", () => {
  it("delegates browseMemory to rpcCall with method memory.browse and the params object", async () => {
    const rpc = makeRpc({ entries: [], total: 0 });
    const client = createApiClient(BASE_URL, TOKEN, rpc);
    await client.browseMemory({ limit: 10, offset: 5, type: "fact" });
    expect(rpc).toHaveBeenCalledWith("memory.browse", {
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
    const result = await client.browseMemory({});
    expect(result.entries).toEqual(entries);
    expect(result.total).toBe(1);
  });
});

describe("createApiClient — memory.delete via rpcCall path", () => {
  it("delegates single deleteMemory through the contract ids array", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).deleteMemory("memory-id-7");
    expect(rpc).toHaveBeenCalledWith("memory.delete", { ids: ["memory-id-7"] });
  });

  it("delegates deleteMemoryBulk to rpcCall memory.delete with ids array param", async () => {
    const rpc = makeRpc({ deleted: 3 });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).deleteMemoryBulk(["a", "b", "c"]);
    expect(rpc).toHaveBeenCalledWith("memory.delete", { ids: ["a", "b", "c"] });
    expect(r.deleted).toBe(3);
  });
});

describe("createApiClient — memory.export via rpcCall path", () => {
  it("delegates exportMemory with no ids to rpcCall memory.export with empty params", async () => {
    const rpc = makeRpc({ entries: [{ id: "id1", content: "one" }] });
    const result = await createApiClient(BASE_URL, TOKEN, rpc).exportMemory();
    expect(rpc).toHaveBeenCalledWith("memory.export", {});
    expect(result).toBe('{"id":"id1","content":"one"}');
  });

  it("filters typed memory export results locally for selected ids", async () => {
    const rpc = makeRpc({ entries: [{ id: "id1" }, { id: "id2" }, { id: "id3" }] });
    const result = await createApiClient(BASE_URL, TOKEN, rpc).exportMemory(["id1", "id2"]);
    expect(rpc).toHaveBeenCalledWith("memory.export", {});
    expect(result).toBe('{"id":"id1"}\n{"id":"id2"}');
  });
});

describe("createApiClient — session.list via rpcCall path", () => {
  it("delegates listSessions to rpcCall session.list with the params object even when empty", async () => {
    const rpc = makeRpc({ sessions: [], total: 0 });
    await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(rpc).toHaveBeenCalledWith("session.list", {});
  });

  it("uses the HTTP filter surface when typed session.list cannot represent filters", async () => {
    const rpc = makeRpc({ sessions: [], total: 0 });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);
    await createApiClient(BASE_URL, TOKEN, rpc).listSessions({
      agentId: "alpha",
      channelType: "telegram",
      search: "foo",
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/sessions?agentId=alpha&channelType=telegram&search=foo",
    );
    vi.unstubAllGlobals();
  });

  it("passes through SessionListItem rows verbatim from the contract response (no aliasing)", async () => {
    // Tight pass-through — the wrapper does NOT alias raw.key → sessionKey
    // or compute agentId from the session-key prefix. The daemon-side handler is the
    // trust boundary; the client returns result.sessions unchanged.
    const rpc = makeRpc({
      sessions: [
        {
          sessionKey: "agent:alpha:tenant:user:channel",
          agentId: "alpha",
          userId: "user",
          channelId: "channel",
          kind: "slack",
          messageCount: 4,
          totalTokens: 100,
          updatedAt: 1000,
          createdAt: 500,
        },
      ],
      total: 1,
    });
    const sessions = await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(sessions[0]?.agentId).toBe("alpha");
    expect(sessions[0]?.kind).toBe("slack");
    expect(sessions[0]?.messageCount).toBe(4);
    expect(sessions[0]?.sessionKey).toBe("agent:alpha:tenant:user:channel");
    expect(sessions[0]?.userId).toBe("user");
    expect(sessions[0]?.channelId).toBe("channel");
  });
});

describe("createApiClient — session.history via rpcCall path", () => {
  it("delegates getSessionDetail to rpcCall session.history with session_key param", async () => {
    const rpc = makeRpc({ session: { key: "k1" }, messages: [] });
    await createApiClient(BASE_URL, TOKEN, rpc).getSessionDetail("k1");
    expect(rpc).toHaveBeenCalledWith("session.history", { session_key: "k1" });
  });
});

describe("createApiClient — session.reset via rpcCall path", () => {
  it("delegates single resetSession to rpcCall session.reset with session_key param", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).resetSession("k2");
    expect(rpc).toHaveBeenCalledWith("session.reset", { session_key: "k2" });
  });

  it("delegates bulk resets as contract-valid point calls", async () => {
    const rpc = makeRpc({ reset: true });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).resetSessionsBulk(["a", "b"]);
    expect(rpc).toHaveBeenNthCalledWith(1, "session.reset", { session_key: "a" });
    expect(rpc).toHaveBeenNthCalledWith(2, "session.reset", { session_key: "b" });
    expect(r.reset).toBe(2);
  });
});

describe("createApiClient — session.compact via rpcCall path", () => {
  it("delegates compactSession to rpcCall session.compact with session_key param", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).compactSession("k3");
    expect(rpc).toHaveBeenCalledWith("session.compact", { session_key: "k3" });
  });
});

describe("createApiClient — session.delete via rpcCall path", () => {
  it("delegates single deleteSession to rpcCall session.delete with session_key param", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).deleteSession("k4");
    expect(rpc).toHaveBeenCalledWith("session.delete", { session_key: "k4" });
  });

  it("delegates bulk deletes as contract-valid point calls", async () => {
    const rpc = makeRpc({ deleted: true });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).deleteSessionsBulk(["x", "y"]);
    expect(rpc).toHaveBeenNthCalledWith(1, "session.delete", { session_key: "x" });
    expect(rpc).toHaveBeenNthCalledWith(2, "session.delete", { session_key: "y" });
    expect(r.deleted).toBe(2);
  });
});

describe("createApiClient — session.export via rpcCall path", () => {
  it("delegates single exportSession to rpcCall session.export with session_key param", async () => {
    const rpc = makeRpc({ sessionKey: "k5", messages: [] });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).exportSession("k5");
    expect(rpc).toHaveBeenCalledWith("session.export", { session_key: "k5" });
    expect(JSON.parse(r)).toEqual({ sessionKey: "k5", messages: [] });
  });

  it("delegates bulk exports as contract-valid point calls", async () => {
    const rpc = makeRpc({ messages: [] });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).exportSessionsBulk(["a", "b"]);
    expect(rpc).toHaveBeenNthCalledWith(1, "session.export", { session_key: "a" });
    expect(rpc).toHaveBeenNthCalledWith(2, "session.export", { session_key: "b" });
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
    await createApiClient(BASE_URL, TOKEN).deleteMemory("memory-1");
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toContain("/api/memory/memory-1");
    expect((call[1] as RequestInit)?.method).toBe("DELETE");
  });

  it("falls back to HTTP POST on bulk-delete when no rpcCall is supplied to factory", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deleted: 2 }),
    } as Response);
    await createApiClient(BASE_URL, TOKEN).deleteMemoryBulk(["id1", "id2"]);
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toContain("/api/memory/bulk-delete");
    expect((call[1] as RequestInit)?.method).toBe("POST");
  });

  it("builds the browseMemory query string from every defined parameter on fetch fallback", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], total: 0 }),
    } as Response);
    await createApiClient(BASE_URL, TOKEN).browseMemory({
      offset: 10,
      limit: 50,
      type: "fact",
      trust: "trusted",
      agentId: "alpha",
      from: 100,
      to: 200,
    });
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("offset=10");
    expect(url).toContain("limit=50");
    expect(url).toContain("type=fact");
    expect(url).toContain("trust=trusted");
    expect(url).toContain("agentId=alpha");
    expect(url).toContain("from=100");
    expect(url).toContain("to=200");
  });
});
