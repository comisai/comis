// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assembleParentCachePrompt } from "./prompt-parent-cache.js";

describe("prompt parent cache module", () => {
  it("exports the typed parent cache assembler", () => {
    expect(assembleParentCachePrompt).toBeTypeOf("function");
  });
});
