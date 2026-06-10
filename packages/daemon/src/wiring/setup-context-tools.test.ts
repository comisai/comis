// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the in-session expansion-loop daemon wiring
 * (`wireContextTools`).
 *
 * Asserts the composition root pushes the three never-export `ctx_*` tools
 * (`ctx_search` / `ctx_inspect` / `ctx_expand`) onto the agent tool array,
 * sharing ONE `ContextToolDeps` built from the injected store + the daemon's
 * logger/clock/budget/tool-results resolver. The store arrives AS the core
 * `ContextStorePort` TYPE (the agent-to-store cut holds — the daemon injects the
 * concrete LCD adapter; the skills/agent layers see only the type).
 *
 * The second test drives `ctx_search.execute` inside a live-session context with
 * a stub store and asserts it calls the INJECTED `store.searchLcd` — proving the
 * wiring threads the deps through rather than re-constructing them. Deep tool
 * behavior is covered by the Plan-03 tool tests; this is the wiring seam only.
 *
 * Imports the real `@comis/skills/tools` factories (resolved from the built
 * `dist`).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { wireContextTools, resolveCtxExpandDepth } from "./setup-context-tools.js";
import { runWithContext } from "@comis/core";
import type { ContextStorePort, LcdSearchHit, LcdSearchResult } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

type ToolLike = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

const THREE_NAMES = ["ctx_search", "ctx_inspect", "ctx_expand"];

/**
 * A stub ContextStorePort — only the methods the wired tools touch are
 * implemented (AGENTS.md §2.5 hand-built `as unknown as` double). `searchLcd`
 * is a vi.fn so we can assert it was invoked through the injected reference.
 */
function makeStubStore(searchLcd = vi.fn((): LcdSearchResult => ({ hits: [], cjkZeroHit: false }))): ContextStorePort {
  return {
    searchLcd,
    getSummaries: vi.fn(() => []),
    getSummaryChildren: vi.fn(() => []),
    getSummaryMessages: vi.fn(() => []),
    getMessages: vi.fn(() => []),
  } as unknown as ContextStorePort;
}

function makeDeps() {
  return {
    skillsLogger: createMockLogger(),
    nowMs: () => 1_700_000_000_000,
    maxExpandTokens: 4_000,
    getToolResultsDir: () => undefined,
  };
}

describe("wireContextTools — daemon composition root", () => {
  it("pushes the three never-export ctx tools onto the agent tool array", () => {
    const tools: ToolLike[] = [];
    wireContextTools(tools as never, makeStubStore(), "agent-a", makeDeps());

    const names = tools.map((t) => t.name);
    for (const expected of THREE_NAMES) {
      expect(names).toContain(expected);
    }
    expect(tools).toHaveLength(3);
  });

  it("threads the injected store and deps into each tool (ctx_search calls store.searchLcd)", async () => {
    const searchLcd = vi.fn((): LcdSearchResult => ({
      hits: [{ kind: "summary", refId: "s1", snippet: "recovered" } as LcdSearchHit],
      cjkZeroHit: false,
    }));
    const tools: ToolLike[] = [];
    wireContextTools(tools as never, makeStubStore(searchLcd), "agent-a", makeDeps());

    const ctxSearch = tools.find((t) => t.name === "ctx_search");
    expect(ctxSearch).toBeDefined();

    // Drive execute inside a live, FULLY-SCOPED session so the per-call scope-gate
    // passes (R4 132-03: the ctx tools require a live agentId + tenantId — WR-02).
    await runWithContext(
      {
        tenantId: "default",
        sessionKey: "default:chan_a:user_a",
        agentId: "agent-a",
        contentDelimiter: "DELIM",
      } as never,
      async () => {
        await ctxSearch!.execute("call-1", { query: "needle" });
      },
    );

    // The wiring passed the SAME store instance through — not a fresh one. R4:
    // searchLcd now receives the full ContextStoreScope built from the LIVE
    // context (conversationId + agentId + tenantId), never a bare conversation id.
    expect(searchLcd).toHaveBeenCalledTimes(1);
    expect(searchLcd).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "default:chan_a:user_a",
        agentId: "agent-a",
        tenantId: "default",
      }),
      expect.any(String),
      expect.objectContaining({ limit: expect.any(Number) }),
    );
  });
});

describe("resolveCtxExpandDepth — DEPTH-02 tier-gated multi-hop depth at wiring time", () => {
  it("resolves an anthropic (frontier) agent model to depth 4", () => {
    expect(resolveCtxExpandDepth("claude-sonnet-4-5-20250929", "anthropic")).toBe(4);
  });
  it("resolves an openai (frontier) agent model to depth 4", () => {
    expect(resolveCtxExpandDepth("gpt-5", "openai")).toBe(4);
  });
  it("resolves a google (mid) agent model to depth 3", () => {
    expect(resolveCtxExpandDepth("gemini-2.5-pro", "google")).toBe(3);
  });
  it("resolves an ollama (small) agent model to depth 2", () => {
    expect(resolveCtxExpandDepth("qwen3.6:35b", "ollama")).toBe(2);
  });
  it("resolves an unknown / empty provider to the small fail-safe (depth 2), never frontier", () => {
    // resolveModelProfile maps any non-anthropic/openai/google family to the
    // fail-SAFE "small" class (model-profile.ts: a 256K ollama never resolves
    // frontier). An empty provider is "small", so the multi-hop depth is 2 — a
    // conservative middle, never the deepest (4) frontier walk for an unknown model.
    expect(resolveCtxExpandDepth("", "")).toBe(2);
    expect(resolveCtxExpandDepth("default", "default")).toBe(2);
  });
});
