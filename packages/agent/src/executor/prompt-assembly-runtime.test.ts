// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assembleExecutionPrompt } from "./prompt-assembly-runtime.js";

describe("prompt assembly runtime module", () => {
  it("exports the canonical execution prompt assembler", () => {
    expect(assembleExecutionPrompt).toBeTypeOf("function");
  });
});
