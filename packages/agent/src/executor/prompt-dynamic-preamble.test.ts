// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildDynamicPreamble,
  renderCurrentExecutionSection,
} from "./prompt-dynamic-preamble.js";

describe("prompt dynamic preamble module", () => {
  it("exports the typed dynamic preamble assembler", () => {
    expect(buildDynamicPreamble).toBeTypeOf("function");
  });

  it("renders the previous proven model binding with current execution state", () => {
    const section = renderCurrentExecutionSection({
      config: {
        provider: "provider_b",
        model: "model_two",
      },
      previousModelBinding: {
        provider: "provider_a",
        model: "model_one",
      },
    } as Parameters<typeof renderCurrentExecutionSection>[0]);

    expect(section).toContain(
      'Previous active model: {"provider":"provider_a","model":"model_one"}',
    );
    expect(section).toContain("successful current-session configuration transitions");
  });
});
