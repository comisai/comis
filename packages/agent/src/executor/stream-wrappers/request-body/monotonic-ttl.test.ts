// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `enforceMonotonicTtlOrdering` — the safety-net sweep
 * that enforces Anthropic's monotonic non-increasing TTL invariant
 * across `tools` -> `system` -> `messages` payload order.
 *
 * Tests cover:
 *  1. zero markers (no-op, no WARN)
 *  2. single marker (no-op, no WARN)
 *  3. already monotonic (no-op, no WARN)
 *  4. production failure shape (live-observed 400 reproducer)
 *  5. multi-upgrade (two earlier 5m + one late 1h)
 *  6. cross-region (5m in system, 1h in first message)
 *  7. tools-prefix (5m on a tool block, 1h in system)
 *  8. non-ephemeral / no cache_control (ignored entirely)
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { enforceMonotonicTtlOrdering } from "./monotonic-ttl.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as ComisLogger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enforceMonotonicTtlOrdering", () => {
  it("zero markers: no-op, no WARN log even when payload has content blocks", () => {
    const logger = makeLogger();
    const result: Record<string, unknown> = {
      tools: [{ name: "search" }, { name: "fetch" }],
      system: [{ type: "text", text: "system prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
    };

    enforceMonotonicTtlOrdering(result, logger);

    expect(logger.warn).not.toHaveBeenCalled();
    // Payload should be untouched.
    expect((result.system as Array<Record<string, unknown>>)[0]!.cache_control).toBeUndefined();
  });

  it("single marker: no-op, no WARN log (nothing to compare against)", () => {
    const logger = makeLogger();
    const result: Record<string, unknown> = {
      tools: [],
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    };

    enforceMonotonicTtlOrdering(result, logger);

    expect(logger.warn).not.toHaveBeenCalled();
    expect((result.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("already monotonic (system=1h followed by messages=5m): no-op, no WARN, message stays 5m", () => {
    const logger = makeLogger();
    const result: Record<string, unknown> = {
      tools: [],
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "earlier message", cache_control: { type: "ephemeral" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };

    enforceMonotonicTtlOrdering(result, logger);

    expect(logger.warn).not.toHaveBeenCalled();
    // System remains 1h, message marker remains 5m (no ttl property).
    expect((result.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const msg0Content = (result.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(msg0Content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("production failure shape (system=1h, messages[8]=5m, messages[10]=1h, 11 messages): upgrades messages[8] to 1h and emits exactly one WARN", () => {
    const logger = makeLogger();
    // Reproduces the live-observed 400: system carries 1h, an interior message
    // (index 8) carries 5m, the last user message (index 10) carries 1h.
    // Anthropic rejects: "messages.10.content.0.cache_control.ttl: a
    // ttl='1h' cache_control block must not come after a ttl='5m'".
    const messages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 11; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      const content: Array<Record<string, unknown>> = [{ type: "text", text: `msg ${i}` }];
      if (i === 8) {
        content[0]!.cache_control = { type: "ephemeral" }; // 5m
      }
      if (i === 10) {
        content[0]!.cache_control = { type: "ephemeral", ttl: "1h" }; // 1h
      }
      messages.push({ role, content });
    }
    const result: Record<string, unknown> = {
      tools: [],
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages,
    };

    enforceMonotonicTtlOrdering(result, logger);

    // messages[8] should now be upgraded to 1h.
    const msg8Content = (result.messages as Array<Record<string, unknown>>)[8]!.content as Array<Record<string, unknown>>;
    expect(msg8Content[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // messages[10] stays 1h.
    const msg10Content = (result.messages as Array<Record<string, unknown>>)[10]!.content as Array<Record<string, unknown>>;
    expect(msg10Content[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // System stays 1h.
    expect((result.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // WARN fired exactly once with the expected payload shape.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        upgradedCount: 1,
        upgradedLocations: ["messages[8].content[0]"],
        totalMarkers: 3, // system + messages[8] + messages[10]
        errorKind: "internal",
        hint: expect.stringContaining("Safety-net sweep"),
      }),
      expect.stringContaining("MONOTONIC-TTL"),
    );
  });

  it("multi-upgrade (two earlier 5m markers + one late 1h marker): both earlier upgraded to 1h, locations in forward payload order", () => {
    const logger = makeLogger();
    const result: Record<string, unknown> = {
      tools: [],
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }, // 5m
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "early user", cache_control: { type: "ephemeral" } }, // 5m
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "later user", cache_control: { type: "ephemeral", ttl: "1h" } }, // 1h
          ],
        },
      ],
    };

    enforceMonotonicTtlOrdering(result, logger);

    // Both earlier markers upgraded to 1h.
    expect((result.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const msg0Content = (result.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(msg0Content[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Locations should be in forward payload order (system first, then messages).
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        upgradedCount: 2,
        upgradedLocations: ["system[0]", "messages[0].content[0]"],
        totalMarkers: 3,
        errorKind: "internal",
      }),
      expect.stringContaining("MONOTONIC-TTL"),
    );
  });

  it("cross-region (5m in system, 1h on first message): system upgraded to 1h", () => {
    const logger = makeLogger();
    const result: Record<string, unknown> = {
      tools: [],
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }, // 5m
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "user", cache_control: { type: "ephemeral", ttl: "1h" } }, // 1h
          ],
        },
      ],
    };

    enforceMonotonicTtlOrdering(result, logger);

    expect((result.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        upgradedCount: 1,
        upgradedLocations: ["system[0]"],
        totalMarkers: 2,
      }),
      expect.any(String),
    );
  });

  it("tools-prefix (5m on tool block, 1h in system): tool upgraded to 1h", () => {
    const logger = makeLogger();
    const result: Record<string, unknown> = {
      tools: [
        { name: "search", cache_control: { type: "ephemeral" } }, // 5m
      ],
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } }, // 1h
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    };

    enforceMonotonicTtlOrdering(result, logger);

    expect((result.tools as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        upgradedCount: 1,
        upgradedLocations: ["tools[0]"],
        totalMarkers: 2,
      }),
      expect.any(String),
    );
  });

  it("non-ephemeral / no cache_control blocks: ignored entirely, no WARN even when neighbors carry markers", () => {
    const logger = makeLogger();
    const result: Record<string, unknown> = {
      tools: [
        { name: "search" }, // no cache_control
        { name: "fetch", cache_control: { type: "persistent" } }, // non-ephemeral
      ],
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "no cc" }, // no cache_control
            { type: "text", text: "alien cc", cache_control: { type: "custom" } }, // non-ephemeral
          ],
        },
      ],
    };

    enforceMonotonicTtlOrdering(result, logger);

    // The only ephemeral marker is system[0]=1h; nothing precedes it that
    // requires upgrade, so no WARN.
    expect(logger.warn).not.toHaveBeenCalled();
    // Non-ephemeral markers untouched.
    expect((result.tools as Array<Record<string, unknown>>)[1]!.cache_control).toEqual({ type: "persistent" });
    const msg0Content = (result.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(msg0Content[1]!.cache_control).toEqual({ type: "custom" });
  });
});
