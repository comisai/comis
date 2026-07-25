// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { buildDynamicPreamble } from "./prompt-dynamic-preamble.js";

describe("prompt dynamic preamble module", () => {
  it("exports the typed dynamic preamble assembler", () => {
    expect(buildDynamicPreamble).toBeTypeOf("function");
  });
});
