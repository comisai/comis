// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for {@link applyToolChoice} (tool-choice-payload.ts).
 *
 * The load-bearing property is a CACHE property, not a formatting one. A turn that must not
 * call tools can either ship an empty tools block or ship the normal tools with a provider-side
 * refusal. The tools block is the FIRST element of the cache key (tools → system → messages),
 * so emptying it invalidates every cached message behind it — and again when the next ordinary
 * turn restores them. This module implements the second, prefix-preserving option: it writes
 * ONLY the refusal field and never touches the tools it was handed.
 *
 * The four behaviors pinned here:
 *   - CONSTRAINED + tools present → the refusal field is written (the prefix-preserving path).
 *   - UNCONSTRAINED → nothing is written, for any tools shape (an ordinary turn is untouched).
 *   - CONSTRAINED + no callable tools → nothing is written: with no tools present the
 *     constraint is already structurally satisfied, so the field would be noise.
 *   - The `tools` argument is never mutated, and no other body key is added or removed —
 *     writing this field must not become a second way to change what the turn ships.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { applyToolChoice } from "./tool-choice-payload.js";

/** A minimal callable-tool stand-in — the function only ever checks array-ness and length. */
const TOOLS = [{ name: "read" }, { name: "write" }];

describe("applyToolChoice — the no-tool-calls constraint", () => {
  it("writes the refusal field when the turn is constrained AND ships callable tools", () => {
    const body: Record<string, unknown> = { model: "m" };

    applyToolChoice(body, TOOLS, "none");

    expect(body.tool_choice).toEqual({ type: "none" });
  });

  it("leaves the body untouched when the turn is not constrained", () => {
    const body: Record<string, unknown> = { model: "m" };

    applyToolChoice(body, TOOLS, undefined);

    expect(body).toEqual({ model: "m" });
    expect("tool_choice" in body).toBe(false);
  });

  // With no tools on the request the provider has nothing to refuse, so the field carries no
  // information — omitting it keeps the constrained body identical to an ordinary one.
  it("writes nothing when constrained but the turn ships no callable tools", () => {
    for (const tools of [[], undefined, null, "not-an-array", { name: "read" }]) {
      const body: Record<string, unknown> = { model: "m" };

      applyToolChoice(body, tools, "none");

      expect("tool_choice" in body, `tools=${JSON.stringify(tools)} must not write the field`).toBe(false);
    }
  });

  // The whole point is to leave the cached prefix alone: the tools block must come through
  // byte-identical, and the write must not become a second lever on the request shape.
  it("never mutates the tools it was handed, and adds no other body key", () => {
    const tools = [{ name: "read" }];
    const body: Record<string, unknown> = { model: "m", system: "s" };

    applyToolChoice(body, tools, "none");

    expect(tools).toEqual([{ name: "read" }]);
    expect(Object.keys(body).sort()).toEqual(["model", "system", "tool_choice"]);
  });
});
