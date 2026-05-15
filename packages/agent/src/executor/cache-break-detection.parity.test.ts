// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { ClockPort } from "@comis/core";
import {
  MAX_SNAPSHOT_CHARS,
  MAX_TRACKING_ENTRIES,
  clearCacheBreakDetectorSession,
  computeHash,
  createCacheBreakDetector,
  djb2,
  extractAnthropicPromptState,
  extractGeminiPromptState,
  sanitizeMcpToolName,
  sanitizeMcpToolNameForAnalytics,
  type CacheBreakDetector,
  type CacheBreakDetectorOptions,
  type CacheBreakEvent,
  type CacheBreakReason,
  type CheckCacheBreakInput,
  type PendingChanges,
  type PromptStateSnapshot,
  type RecordPromptStateInput,
} from "./cache-break-detection.js";

/**
 * Phase 42 parity protection — EXEC-SPLIT-01.
 *
 * These snapshots lock the byte-identical output of cache-break-detection.ts's
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
 * each parity test file.
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

// ---------------------------------------------------------------------------
// Test-only fixtures (Phase 39 pattern — in-line, no vi.mock ceremony)
// ---------------------------------------------------------------------------

const testClock: ClockPort = {
  now: () => 1_700_000_000_000,
  nowDate: () => new Date(1_700_000_000_000),
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
};

describe("cache-break-detection parity (EXEC-SPLIT-01)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      // Value exports (constants + functions) — type-only exports
      // (PromptStateSnapshot, PendingChanges, CacheBreakReason,
      // CacheBreakEvent, RecordPromptStateInput, CheckCacheBreakInput,
      // CacheBreakDetector, CacheBreakDetectorOptions) are tracked
      // separately as strings.
      const valueExports = {
        MAX_SNAPSHOT_CHARS,
        MAX_TRACKING_ENTRIES,
        clearCacheBreakDetectorSession,
        computeHash,
        createCacheBreakDetector,
        djb2,
        extractAnthropicPromptState,
        extractGeminiPromptState,
        sanitizeMcpToolName,
        sanitizeMcpToolNameForAnalytics,
      };
      const typeExports = [
        "CacheBreakDetector",
        "CacheBreakDetectorOptions",
        "CacheBreakEvent",
        "CacheBreakReason",
        "CheckCacheBreakInput",
        "PendingChanges",
        "PromptStateSnapshot",
        "RecordPromptStateInput",
      ] as const;
      expect(
        stableStringify({
          values: Object.keys(valueExports).sort(),
          types: [...typeExports].sort(),
        }),
      ).toMatchSnapshot();
    });

    it("module-level constants: exact values", () => {
      expect(
        stableStringify({ MAX_SNAPSHOT_CHARS, MAX_TRACKING_ENTRIES }),
      ).toMatchSnapshot();
    });

    it("createCacheBreakDetector — returned interface shape (Object.keys)", () => {
      const options: CacheBreakDetectorOptions = { clock: testClock };
      const detector = createCacheBreakDetector(noopLogger, options);
      // The returned object literal does not expose its method names via
      // Object.keys() unless they appear as own properties. The factory
      // returns an object literal whose own-keys ARE the method names.
      expect(stableStringify(Object.keys(detector).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix — representative inputs", () => {
    it("djb2: returns hash for 3 representative strings", () => {
      expect(
        stableStringify({
          empty: djb2(""),
          short: djb2("hello"),
          longer: djb2("the quick brown fox jumps over the lazy dog"),
          unicode: djb2("héllo wörld"),
        }),
      ).toMatchSnapshot();
    });

    it("computeHash — primitives + objects + undefined", () => {
      expect(
        stableStringify({
          str: computeHash("plain string"),
          obj: computeHash({ a: 1, b: "two", c: [3, 4] }),
          arr: computeHash([1, 2, 3]),
          undef: computeHash(undefined),
          nullVal: computeHash(null),
          empty: computeHash(""),
        }),
      ).toMatchSnapshot();
    });

    it("sanitizeMcpToolName — 4 representative tool names", () => {
      expect(
        stableStringify({
          builtin: sanitizeMcpToolName("bash"),
          mcpFull: sanitizeMcpToolName("mcp__myserver--mytool"),
          mcpNoSep: sanitizeMcpToolName("mcp__serveronly"),
          mcpWithPath: sanitizeMcpToolName("mcp__server--tool--with--dashes"),
        }),
      ).toMatchSnapshot();
    });

    it("sanitizeMcpToolNameForAnalytics — collapses MCP to bare 'mcp'", () => {
      expect(
        stableStringify({
          builtin: sanitizeMcpToolNameForAnalytics("bash"),
          mcpFull: sanitizeMcpToolNameForAnalytics("mcp__myserver--mytool"),
          mcpAny: sanitizeMcpToolNameForAnalytics("mcp__anything"),
        }),
      ).toMatchSnapshot();
    });

    it("extractAnthropicPromptState — synthetic request body", () => {
      const params = {
        system: [
          { type: "text", text: "You are a helpful assistant", cache_control: { type: "ephemeral" } },
        ],
        tools: [
          {
            name: "bash",
            description: "Run bash",
            input_schema: { type: "object", properties: { cmd: { type: "string" } } },
            cache_control: { type: "ephemeral" },
          },
          {
            name: "file_read",
            description: "Read file",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
          },
        ],
      } as Record<string, unknown>;

      const result = extractAnthropicPromptState(
        params,
        "claude-sonnet-4-5",
        "short",
        "session-abc",
        "agent-xyz",
        { "anthropic-beta": "context-1m-2025-08-07", "anthropic-version": "2023-06-01" },
      );
      // The lazy `buildDiffableContent` getter is a function — not stable
      // under JSON serialization. Strip it from the snapshot and capture
      // its existence + invocation output separately.
      const { buildDiffableContent, ...rest } = result;
      expect(
        stableStringify({
          ...rest,
          buildDiffableContentTypeof: typeof buildDiffableContent,
          buildDiffableContentInvocation: buildDiffableContent?.(),
        }),
      ).toMatchSnapshot();
    });

    it("extractGeminiPromptState — synthetic request body", () => {
      const params = {
        config: {
          systemInstruction: "You are a helpful assistant",
          tools: [
            {
              functionDeclarations: [
                {
                  name: "bash",
                  description: "Run bash",
                  parametersJsonSchema: { type: "object", properties: { cmd: { type: "string" } } },
                },
                {
                  name: "mcp__alpha--read",
                  description: "Read",
                  parametersJsonSchema: { type: "object", properties: { path: { type: "string" } } },
                },
              ],
            },
          ],
        },
      } as Record<string, unknown>;
      const result = extractGeminiPromptState(
        params,
        "gemini-2.0-flash",
        "session-def",
        "agent-abc",
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("createCacheBreakDetector — first-call baseline returns null", () => {
      const detector: CacheBreakDetector = createCacheBreakDetector(noopLogger, {
        clock: testClock,
      });
      const input: RecordPromptStateInput = {
        sessionKey: "parity-session-1",
        agentId: "agent-1",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        systemHash: 12345,
        toolsHash: 67890,
        cacheMetadataHash: null,
        toolNames: ["bash"],
        perToolHashes: { bash: 111 },
        retention: "short",
        headersHash: null,
        extraBodyHash: null,
      };
      detector.recordPromptState(input);
      const checkInput: CheckCacheBreakInput = {
        sessionKey: "parity-session-1",
        provider: "anthropic",
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalInputTokens: 1000,
      };
      const firstEvent = detector.checkResponseForCacheBreak(checkInput);
      // First call: detector records baseline and returns null.
      expect(
        stableStringify({ event: firstEvent, isNull: firstEvent === null }),
      ).toMatchSnapshot();
      // Cleanup so this test does not leak into the next one (module-level
      // state is per-instance via createLruMap; reset() is the safe path).
      detector.reset();
    });

    it("CacheBreakReason — exhaustive enumerated union snapshot", () => {
      // Type-level enumeration via a hand-maintained witness mapping each
      // valid CacheBreakReason to a no-op value. Drift in the union
      // surface invalidates the snapshot.
      const reasons: ReadonlyArray<CacheBreakReason> = [
        "cache_control_changed",
        "cache_metadata_changed",
        "effort_changed",
        "extra_body_changed",
        "headers_changed",
        "likely_server_eviction",
        "lookback_window_exceeded",
        "model_changed",
        "retention_changed",
        "server_eviction",
        "system_changed",
        "tools_changed",
        "ttl_expiry",
        "ttl_expiry_long",
        "ttl_expiry_short",
      ];
      expect(stableStringify([...reasons].sort())).toMatchSnapshot();
    });
  });
});

// Sentinel: ensure type-only imports compile (and the symbol set is current).
// If any of these types disappear post-split, the parity test fails at the
// TypeScript layer before runtime — a stronger guarantee than the symbol
// snapshot alone.
type _TypeOnlySentinel = [
  CacheBreakDetector,
  CacheBreakDetectorOptions,
  CacheBreakEvent,
  CacheBreakReason,
  CheckCacheBreakInput,
  PendingChanges,
  PromptStateSnapshot,
  RecordPromptStateInput,
];
// Force the alias to be "used" so the compiler doesn't error under
// `--noUnusedLocals` if that flag is ever enabled on this test tree.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeOnlyHolder: _TypeOnlySentinel | undefined = undefined;
