// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tool-deferral-injection.ts — focused on the DEFERRAL_STUB_MARKER
 * guard inside injectToolDeferral.
 *
 * These tests exist as a regression guard against the broken
 * `discover_tools → tool_search_tool_regex_20251119` swap (yfinance trace,
 * plan 260520-e9x). Auto-discovery stubs (`createAutoDiscoveryStubs` in
 * `tool-deferral.ts`) tag the stub tool object with `[DEFERRAL_STUB_MARKER]:
 * true`. The stub-filter wrapper later strips those stubs from the API
 * payload by name, but `injectToolDeferral` runs FIRST in the onPayload
 * chain (innermost-wrapper-runs-last semantics in `composeStreamWrappers`),
 * so it must guard against the marker explicitly. Without the guard,
 * exclude-model sessions whose only deferred matches were stubs would
 * falsely set `deferCount > 0`, remove `discover_tools`, and append the
 * server-side `tool_search_tool_regex` tool — at which point neither
 * discovery mechanism works.
 *
 * The five cases below pin: stub-only (no swap), non-stub (swap intact),
 * mixed (swap once, stub left for downstream filter), latch-off (no
 * mutation), and unsupported model id (no mutation).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { injectToolDeferral } from "./tool-deferral-injection.js";
import { DEFERRAL_STUB_MARKER } from "../../tool-deferral.js";
import type { ComisLogger } from "@comis/core";
import type { RequestBodyInjectorConfig } from "./types.js";
import type { SessionLatch } from "../../session-latch.js";

// ---------------------------------------------------------------------------
// Local factories
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
}

/**
 * Build a minimal RequestBodyInjectorConfig stub exposing only the fields
 * injectToolDeferral reads: getDeferredToolNames and getDeferLoadingLatch.
 * The other 30+ optional fields are not touched by the injector, so an
 * `as unknown as RequestBodyInjectorConfig` cast is safe.
 */
function makeConfig(opts: {
  deferred: string[];
  latchValue?: boolean | "no-latch";
}): RequestBodyInjectorConfig {
  const latchValue = opts.latchValue ?? true;
  const config: Partial<RequestBodyInjectorConfig> = {
    getDeferredToolNames: () => new Set(opts.deferred),
  };
  if (latchValue !== "no-latch") {
    config.getDeferLoadingLatch = () => ({
      get: () => latchValue,
      setOnce: (_v: boolean) => latchValue,
      reset: () => {},
    } as SessionLatch<boolean>);
  }
  return config as unknown as RequestBodyInjectorConfig;
}

// A Sonnet-class id makes supportsToolSearch() return true; Haiku is rejected.
const SONNET_ID = "claude-sonnet-4-5-20250929";
const HAIKU_ID = "claude-haiku-4-20250514";

describe("injectToolDeferral DEFERRAL_STUB_MARKER guard", () => {
  it("skips stub-marked tools so the discover_tools swap is suppressed", () => {
    const tools = [
      { name: "tool_a", [DEFERRAL_STUB_MARKER]: true },
      { name: "discover_tools" },
    ];
    const payload: Record<string, unknown> = { tools };

    injectToolDeferral(
      payload,
      SONNET_ID,
      makeConfig({ deferred: ["tool_a"] }),
      makeLogger(),
    );

    // Stub MUST NOT be flagged defer_loading.
    expect((tools[0] as Record<string, unknown>).defer_loading).toBeUndefined();
    // discover_tools MUST remain in the payload — client-side discovery is preserved.
    expect(tools.some(t => (t as Record<string, unknown>).name === "discover_tools")).toBe(true);
    // Server-side tool_search MUST NOT be appended.
    expect(
      tools.some(t => {
        const ty = (t as Record<string, unknown>).type;
        return typeof ty === "string" && ty.startsWith("tool_search_tool_");
      }),
    ).toBe(false);
  });

  it("flags non-stub deferred tools and performs the discover_tools swap", () => {
    const tools = [
      { name: "tool_a" },
      { name: "discover_tools" },
    ];
    const payload: Record<string, unknown> = { tools };

    injectToolDeferral(
      payload,
      SONNET_ID,
      makeConfig({ deferred: ["tool_a"] }),
      makeLogger(),
    );

    // Non-stub deferred MUST be marked defer_loading.
    expect((tools[0] as Record<string, unknown>).defer_loading).toBe(true);
    // discover_tools MUST be removed.
    expect(tools.some(t => (t as Record<string, unknown>).name === "discover_tools")).toBe(false);
    // Server-side tool_search MUST be appended.
    const searchTool = tools.find(t => {
      const ty = (t as Record<string, unknown>).type;
      return typeof ty === "string" && ty.startsWith("tool_search_tool_");
    });
    expect(searchTool).toBeDefined();
    expect((searchTool as Record<string, unknown>).type).toBe("tool_search_tool_regex_20251119");
  });

  it("mixed payload flags only the non-stub deferred tool and performs the swap once", () => {
    const tools: Array<Record<string, unknown>> = [
      { name: "tool_a", [DEFERRAL_STUB_MARKER]: true },
      { name: "tool_b" },
      { name: "discover_tools" },
    ];
    const payload: Record<string, unknown> = { tools };

    injectToolDeferral(
      payload,
      SONNET_ID,
      makeConfig({ deferred: ["tool_a", "tool_b"] }),
      makeLogger(),
    );

    // Stub MUST NOT be flagged.
    expect(tools[0].defer_loading).toBeUndefined();
    // Non-stub deferred MUST be flagged.
    expect(tools[1].defer_loading).toBe(true);
    // discover_tools MUST be removed (deferCount === 1 > 0 triggers the swap).
    expect(tools.some(t => t.name === "discover_tools")).toBe(false);
    // Stub remains in the array — stub-filter wrapper strips it later (out of scope here).
    expect(tools.some(t => t.name === "tool_a" && t[DEFERRAL_STUB_MARKER] === true)).toBe(true);
    // Exactly one server-side tool_search appended.
    const searchTools = tools.filter(t => {
      const ty = t.type;
      return typeof ty === "string" && ty.startsWith("tool_search_tool_");
    });
    expect(searchTools).toHaveLength(1);
  });

  it("returns without mutation when the defer-loading latch is set off", () => {
    const tools = [
      { name: "tool_a" },
      { name: "discover_tools" },
    ];
    const payload: Record<string, unknown> = { tools };
    const before = JSON.stringify(tools);

    injectToolDeferral(
      payload,
      SONNET_ID,
      makeConfig({ deferred: ["tool_a"], latchValue: false }),
      makeLogger(),
    );

    // Payload MUST be byte-identical: no defer_loading flag, no swap.
    expect(JSON.stringify(tools)).toBe(before);
  });

  it("returns without mutation when the model id does not support tool_search", () => {
    const tools = [
      { name: "tool_a" },
      { name: "discover_tools" },
    ];
    const payload: Record<string, unknown> = { tools };
    const before = JSON.stringify(tools);

    injectToolDeferral(
      payload,
      HAIKU_ID,
      makeConfig({ deferred: ["tool_a"] }),
      makeLogger(),
    );

    expect(JSON.stringify(tools)).toBe(before);
  });
});
