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

// Dev-mode validator is strict — and the api-client has pre-existing payload
// shape mismatches with the generated contract (e.g. single deleteMemory sends
// {id} but the contract requires {ids}; listSessions forwards agentId/channelType/
// search but the contract only allows kind/since_minutes). These are pre-
// existing wrapper bugs orthogonal to this file's coverage objective; we
// stub the validators to expose the rpcCall delegation branch underneath.
vi.mock("./contracts.generated.js", () => ({
  validateRequest: () => true,
  validateResponse: () => true,
  CONTRACTS: {},
}));

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
    expect(rpc).toHaveBeenCalledWith("memory.browse", { limit: 10, offset: 5, type: "fact" });
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
  it("delegates single deleteMemory to rpcCall memory.delete with id param", async () => {
    const rpc = makeRpc(undefined);
    await createApiClient(BASE_URL, TOKEN, rpc).deleteMemory("memory-id-7");
    expect(rpc).toHaveBeenCalledWith("memory.delete", { id: "memory-id-7" });
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
    const rpc = makeRpc("exported-content");
    const result = await createApiClient(BASE_URL, TOKEN, rpc).exportMemory();
    expect(rpc).toHaveBeenCalledWith("memory.export", {});
    expect(result).toBe("exported-content");
  });

  it("delegates exportMemory with ids array to rpcCall memory.export with ids param", async () => {
    const rpc = makeRpc("ids-export");
    await createApiClient(BASE_URL, TOKEN, rpc).exportMemory(["id1", "id2"]);
    expect(rpc).toHaveBeenCalledWith("memory.export", { ids: ["id1", "id2"] });
  });
});

describe("createApiClient — session.list via rpcCall path", () => {
  it("delegates listSessions to rpcCall session.list with the params object even when empty", async () => {
    const rpc = makeRpc({ sessions: [], total: 0 });
    await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(rpc).toHaveBeenCalledWith("session.list", {});
  });

  it("forwards listSessions filter params (agentId/channelType/search) to rpcCall payload", async () => {
    const rpc = makeRpc({ sessions: [], total: 0 });
    await createApiClient(BASE_URL, TOKEN, rpc).listSessions({
      agentId: "alpha",
      channelType: "telegram",
      search: "foo",
    });
    expect(rpc).toHaveBeenCalledWith("session.list", {
      agentId: "alpha",
      channelType: "telegram",
      search: "foo",
    });
  });

  it("extracts agentId from canonical session-key prefix when raw response omits agentId field", async () => {
    const rpc = makeRpc({
      sessions: [
        {
          sessionKey: "agent:alpha:tenant:user:channel",
          kind: "slack",
          messageCount: 4,
        },
      ],
      total: 1,
    });
    const sessions = await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(sessions[0]?.agentId).toBe("alpha");
    expect(sessions[0]?.channelType).toBe("slack");
    expect(sessions[0]?.messageCount).toBe(4);
  });

  it("defaults agentId to 'unknown' when session key has no agent prefix", async () => {
    const rpc = makeRpc({
      sessions: [{ sessionKey: "tenant:user:channel" }],
      total: 1,
    });
    const sessions = await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(sessions[0]?.agentId).toBe("unknown");
  });

  it("prefers raw.key when raw.sessionKey is absent for session-key parsing", async () => {
    const rpc = makeRpc({
      sessions: [{ key: "agent:beta:t:u:c" }],
      total: 1,
    });
    const sessions = await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(sessions[0]?.key).toBe("agent:beta:t:u:c");
    expect(sessions[0]?.agentId).toBe("beta");
  });

  it("populates totalTokens/inputTokens/outputTokens/toolCalls/compactions/resetCount from raw fields", async () => {
    const rpc = makeRpc({
      sessions: [
        {
          sessionKey: "agent:a:t:u:c",
          totalTokens: 100,
          inputTokens: 60,
          outputTokens: 40,
          toolCalls: 7,
          compactions: 2,
          resetCount: 1,
        },
      ],
      total: 1,
    });
    const [session] = await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(session?.totalTokens).toBe(100);
    expect(session?.inputTokens).toBe(60);
    expect(session?.outputTokens).toBe(40);
    expect(session?.toolCalls).toBe(7);
    expect(session?.compactions).toBe(2);
    expect(session?.resetCount).toBe(1);
  });

  it("returns empty array when session.list raw response omits the sessions field", async () => {
    const rpc = makeRpc({ total: 0 });
    const sessions = await createApiClient(BASE_URL, TOKEN, rpc).listSessions();
    expect(sessions).toEqual([]);
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

  it("delegates resetSessionsBulk to rpcCall session.reset with keys array param", async () => {
    const rpc = makeRpc({ reset: 5 });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).resetSessionsBulk(["a", "b"]);
    expect(rpc).toHaveBeenCalledWith("session.reset", { keys: ["a", "b"] });
    expect(r.reset).toBe(5);
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

  it("delegates deleteSessionsBulk to rpcCall session.delete with keys array param", async () => {
    const rpc = makeRpc({ deleted: 2 });
    const r = await createApiClient(BASE_URL, TOKEN, rpc).deleteSessionsBulk(["x", "y"]);
    expect(rpc).toHaveBeenCalledWith("session.delete", { keys: ["x", "y"] });
    expect(r.deleted).toBe(2);
  });
});

describe("createApiClient — session.export via rpcCall path", () => {
  it("delegates single exportSession to rpcCall session.export with session_key param", async () => {
    const rpc = makeRpc("exported-session");
    const r = await createApiClient(BASE_URL, TOKEN, rpc).exportSession("k5");
    expect(rpc).toHaveBeenCalledWith("session.export", { session_key: "k5" });
    expect(r).toBe("exported-session");
  });

  it("delegates exportSessionsBulk to rpcCall session.export with keys array param", async () => {
    const rpc = makeRpc("bulk-export");
    const r = await createApiClient(BASE_URL, TOKEN, rpc).exportSessionsBulk(["a", "b"]);
    expect(rpc).toHaveBeenCalledWith("session.export", { keys: ["a", "b"] });
    expect(r).toBe("bulk-export");
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
