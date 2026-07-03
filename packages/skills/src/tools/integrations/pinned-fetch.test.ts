// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the DNS-pinned fetch primitive.
 *
 * `createPinnedAgent` must build an undici Agent whose `connect.lookup` ALWAYS
 * returns the pre-validated IP (both the legacy 3-arg callback form and the
 * Node 22+ Happy-Eyeballs `{all:true}` array form), and `fetchPinned` must issue
 * the request through that agent as the dispatcher AND always close the agent
 * afterwards (success and failure), preserving the original URL for TLS SNI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock undici with a real Agent class that records its connect.lookup config and
// a close spy, plus a fetch spy the tests control. vi.hoisted exposes the refs.
const { agents, mockFetch } = vi.hoisted(() => {
  const agents: Array<{ lookup: (...a: unknown[]) => void; closed: boolean }> = [];
  const mockFetch = vi.fn();
  return { agents, mockFetch };
});

vi.mock("undici", () => {
  class MockAgent {
    closed = false;
    lookup: (...a: unknown[]) => void;
    constructor(opts: { connect: { lookup: (...a: unknown[]) => void } }) {
      this.lookup = opts.connect.lookup;
      agents.push(this);
    }
    close = vi.fn(async () => {
      this.closed = true;
    });
  }
  return { Agent: MockAgent, fetch: mockFetch };
});

import { createPinnedAgent, fetchPinned } from "./pinned-fetch.js";

describe("createPinnedAgent", () => {
  beforeEach(() => {
    agents.length = 0;
    mockFetch.mockReset();
  });

  it("returns the pinned IPv4 via the legacy 3-arg lookup callback", () => {
    createPinnedAgent("127.0.0.1");
    const agent = agents[0]!;
    const cb = vi.fn();
    agent.lookup("example.host", {}, cb);
    // legacy form: callback(null, address, family)
    expect(cb).toHaveBeenCalledWith(null, "127.0.0.1", 4);
  });

  it("returns the pinned IP as an array for the Node 22+ {all:true} Happy-Eyeballs form", () => {
    createPinnedAgent("10.0.0.5");
    const agent = agents[0]!;
    const cb = vi.fn();
    agent.lookup("example.host", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "10.0.0.5", family: 4 }]);
  });

  it("infers IPv6 family (6) from a colon-bearing IP", () => {
    createPinnedAgent("::1");
    const agent = agents[0]!;
    const cb = vi.fn();
    agent.lookup("example.host", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "::1", 6);
  });
});

describe("fetchPinned", () => {
  beforeEach(() => {
    agents.length = 0;
    mockFetch.mockReset();
  });

  it("fetches the ORIGINAL url through a pinned dispatcher and closes the agent on success", async () => {
    const response = { ok: true, status: 200 };
    mockFetch.mockResolvedValue(response);

    const result = await fetchPinned("http://127.0.0.1:9000/v1/x", "127.0.0.1", {
      method: "GET",
    });

    expect(result).toBe(response);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    // Original URL preserved (TLS SNI / hostname intact); dispatcher is the agent.
    expect(url).toBe("http://127.0.0.1:9000/v1/x");
    expect((init as { method?: string }).method).toBe("GET");
    expect((init as { dispatcher?: unknown }).dispatcher).toBe(agents[0]);
    // The pinned agent was closed after the request settled (no socket leak).
    expect(agents[0]!.closed).toBe(true);
  });

  it("closes the agent even when the fetch rejects (cleanup on error path)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      fetchPinned("http://127.0.0.1:9000", "127.0.0.1", { method: "GET" }),
    ).rejects.toThrow("ECONNREFUSED");

    expect(agents[0]!.closed).toBe(true);
  });
});
