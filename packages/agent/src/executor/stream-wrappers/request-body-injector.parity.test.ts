// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { CacheRetention } from "@mariozechner/pi-ai";
import {
  CACHEABLE_BLOCK_TYPES,
  addCacheControlToLastBlock,
  clearSessionBetaHeaderLatches,
  clearSessionCadenceTracker,
  clearSessionPrefixStability,
  clearStaleThinkingBlocks,
  createRequestBodyInjector,
  estimateBlockTokens,
  getMinCacheableTokens,
  hashBreakpointContent,
  identifyBreakpointZone,
  maybePromoteBreakpoints,
  resolveCacheRetention,
  sortToolsForCacheStability,
  type RequestBodyInjectorConfig,
} from "./request-body/index.js";

/**
 * Phase 42 parity protection — EXEC-SPLIT-01.
 *
 * These snapshots lock the byte-identical output of request-body-injector.ts's
 * public-API functions BEFORE the Phase 42 split refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change FAILS this test → fails `pnpm test` → fails the per-commit gate.
 *
 * Captured: in the Phase 42 reference commit (plan 42-01). Subsequent split
 * commits (Wave 2 cache-detection → Wave 3 request-body → Wave 4
 * prompt-runner → Wave 5 pi-executor) must keep this test green. Per
 * EXEC-SPLIT-14, this file is DELETED in plan 42-06 after each new
 * structure has ≥1 independent behavior test per extracted module.
 *
 * Open-question Q1 decision (locked): signatures + 5-8 behavior matrix
 * it() blocks per file.
 * Open-question Q3 decision (locked): `stableStringify` copied verbatim in
 * each parity test file (rule of three — defer extraction until 5th
 * non-parity consumer).
 */

function stableStringify(value: unknown): string {
  // Sort keys deterministically; drop `description: undefined` keys consistently;
  // produces a snapshot string that does not vary across Node patch versions.
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(val as Record<string, unknown>).sort()) {
          const v = (val as Record<string, unknown>)[k];
          if (v !== undefined) sorted[k] = v;
        }
        return sorted;
      }
      return val;
    },
    2,
  );
}

describe("request-body-injector parity (EXEC-SPLIT-01)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        CACHEABLE_BLOCK_TYPES,
        addCacheControlToLastBlock,
        clearSessionBetaHeaderLatches,
        clearSessionCadenceTracker,
        clearSessionPrefixStability,
        clearStaleThinkingBlocks,
        createRequestBodyInjector,
        estimateBlockTokens,
        getMinCacheableTokens,
        hashBreakpointContent,
        identifyBreakpointZone,
        maybePromoteBreakpoints,
        resolveCacheRetention,
        sortToolsForCacheStability,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });

    it("CACHEABLE_BLOCK_TYPES — constant set membership", () => {
      // Snapshot the sorted member list — `Set` is not JSON-serializable as-is.
      expect(stableStringify([...CACHEABLE_BLOCK_TYPES].sort())).toMatchSnapshot();
    });

    it("createRequestBodyInjector returns a function (typeof)", () => {
      // Construct with the smallest legal config; do not invoke. Snapshot the
      // resulting wrapper's typeof + name to lock the public shape.
      const config: RequestBodyInjectorConfig = {
        clock: { now: () => 0, nowDate: () => new Date(0) },
        getCacheRetention: () => undefined,
      };
      const noopLogger = {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        child: () => noopLogger,
      } as unknown as import("@comis/core").ComisLogger;
      const wrapper = createRequestBodyInjector(config, noopLogger);
      expect(
        stableStringify({ typeof: typeof wrapper, name: wrapper.name }),
      ).toMatchSnapshot();
    });
  });

  describe("behavior matrix — representative inputs", () => {
    it("addCacheControlToLastBlock on 3-block message (retention=undefined)", () => {
      const msg = {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "thinking", thinking: "thoughts" }, // not cacheable
          { type: "text", text: "last" },
        ],
      };
      addCacheControlToLastBlock(msg);
      expect(stableStringify(msg)).toMatchSnapshot();
    });

    it("addCacheControlToLastBlock on 3-block message (retention=long)", () => {
      const msg = {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "x", name: "bash", input: {} },
          { type: "text", text: "b" },
        ],
      };
      addCacheControlToLastBlock(msg, "long" as CacheRetention);
      expect(stableStringify(msg)).toMatchSnapshot();
    });

    it("getMinCacheableTokens: per-model thresholds (3 representative model IDs)", () => {
      const result = {
        sonnet35: getMinCacheableTokens("claude-3-5-sonnet-20241022"),
        sonnet37: getMinCacheableTokens("claude-3-7-sonnet-20250109"),
        haiku45: getMinCacheableTokens("claude-haiku-4-5"),
        unknown: getMinCacheableTokens("some-unknown-model"),
        undefinedInput: getMinCacheableTokens(undefined),
      };
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("resolveCacheRetention — 2 representative override scenarios", () => {
      const result = {
        noOverrides: resolveCacheRetention(
          "claude-sonnet-4-5",
          "short" as CacheRetention,
          undefined,
        ),
        emptyOverrides: resolveCacheRetention(
          "claude-sonnet-4-5",
          "short" as CacheRetention,
          {},
        ),
        prefixMatch: resolveCacheRetention(
          "claude-haiku-4-5-20251022",
          "short" as CacheRetention,
          { "claude-haiku": "long" as CacheRetention },
        ),
        longestPrefixWins: resolveCacheRetention(
          "claude-sonnet-4-6-20260301",
          "short" as CacheRetention,
          {
            "claude-sonnet": "short" as CacheRetention,
            "claude-sonnet-4-6": "long" as CacheRetention,
          },
        ),
      };
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("estimateBlockTokens — text + tool_use blocks", () => {
      const text = { type: "text", text: "the quick brown fox jumps over the lazy dog" };
      const toolUse = {
        type: "tool_use",
        id: "abc",
        name: "bash",
        input: { command: "ls -la" },
      };
      expect(
        stableStringify({
          text: estimateBlockTokens(text),
          toolUse: estimateBlockTokens(toolUse),
          empty: estimateBlockTokens({ type: "text", text: "" }),
        }),
      ).toMatchSnapshot();
    });

    it("identifyBreakpointZone: boundary cases", () => {
      // Use synthetic position/count pairs that exercise each zone.
      expect(
        stableStringify({
          zeroMessages: identifyBreakpointZone(0, 0),
          atSemiStableBoundary: identifyBreakpointZone(4, 10), // ratio 0.4
          atMidZone: identifyBreakpointZone(5, 10), // ratio 0.5
          atRecentBoundary: identifyBreakpointZone(7, 10), // ratio 0.7
          deepInRecent: identifyBreakpointZone(9, 10), // ratio 0.9
        }),
      ).toMatchSnapshot();
    });

    it("hashBreakpointContent: synthetic message history", () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi there", cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: "stringy content" },
      ];
      expect(
        stableStringify({
          atIdx0: hashBreakpointContent(messages, 0),
          atIdx1: hashBreakpointContent(messages, 1),
          atIdx2: hashBreakpointContent(messages, 2),
        }),
      ).toMatchSnapshot();
    });

    it("sortToolsForCacheStability — builtins/mcp/server ordering", () => {
      const tools = [
        { name: "mcp__zeta--read", input_schema: { type: "object" } },
        { name: "bash", input_schema: { type: "object" } },
        { name: "mcp__alpha--write", input_schema: { type: "object" } },
        { type: "tool_search_tool_regex_20251119", name: "server_search" },
        { name: "file_read", input_schema: { type: "object" } },
      ];
      const sorted = sortToolsForCacheStability(tools);
      expect(stableStringify(sorted.map((t) => ({ name: t.name, type: t.type })))).toMatchSnapshot();
    });
  });
});
