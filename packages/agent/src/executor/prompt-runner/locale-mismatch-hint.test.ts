// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { unrepairedMismatchHint } from "./locale-mismatch-hint.js";

describe("unrepaired locale mismatch guidance", () => {
  it("identifies an inferred request-tier target without blaming the model", () => {
    const hint = unrepairedMismatchHint("request");

    expect(hint).toMatch(/inferred/i);
    expect(hint).toContain("localeSource=request");
    expect(hint).not.toMatch(/model's locale fidelity/i);
    expect(hint).toMatch(/extra model call|prompt cache/i);
  });

  it("identifies an operator pin as authoritative model guidance", () => {
    const hint = unrepairedMismatchHint("explicit");

    expect(hint).toMatch(/operator pin/i);
    expect(hint).toMatch(/locale fidelity/i);
  });
});
