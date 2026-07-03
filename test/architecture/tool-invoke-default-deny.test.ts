// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture gate: the `tool.invoke` default-deny-by-absence invariant.
 *
 * Default-deny is the ABSENCE of a `TOOL_CAPABILITY_MAP` entry: an arbitrary
 * unmapped tool name resolves to `undefined`, which the dispatch turns
 * into a `CapabilityDeniedError` (undispatchable). This pins that an unknown /
 * not-yet-defined / admin tool can never be dispatched as if allowed.
 *
 * Imports the COMPILED `@comis/core` (vitest alias → core/dist) — the runtime
 * map is the closed set the dispatch reads.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { TOOL_CAPABILITY_MAP } from "@comis/core";

describe("tool.invoke default-deny by absence", () => {
  it("an unmapped tool name resolves to no capability (undispatchable)", () => {
    const map = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    // Arbitrary names that are NOT on the curated read/web surface: an unknown
    // tool, a never-defined name, and an admin/management tool. Each must be
    // absent (undefined) → the dispatch denies.
    expect(map.agents_create).toBeUndefined();
    expect(map.definitely_not_a_tool).toBeUndefined();
    expect(map.gateway).toBeUndefined();
    expect(map[""]).toBeUndefined();
    expect(map.__proto__pollution).toBeUndefined();
  });

  it("the curated surface holds only known read/web tool names", () => {
    // Defense-in-depth: enumerate the allowed names so an accidental future
    // addition of an admin tool is caught here too (not just by the denylist
    // arch-test). This is the closed surface the default-deny gate protects.
    const allowed = new Set(Object.keys(TOOL_CAPABILITY_MAP));
    const expected = new Set([
      "memory_search",
      "memory_get",
      "session_search",
      "extract_document",
      "sessions_list",
      "session_status",
      "sessions_history",
      "read",
      "grep",
      "find",
      "ls",
      "jq",
      "sql",
      "jsonpath",
      "web_search",
      "web_fetch",
    ]);
    expect(allowed).toEqual(expected);
  });
});
