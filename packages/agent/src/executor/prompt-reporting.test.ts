// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { persistPromptReport } from "./prompt-reporting.js";

describe("prompt reporting module", () => {
  it("exports the bounded prompt report persistence seam", () => {
    expect(persistPromptReport).toBeTypeOf("function");
  });
});
