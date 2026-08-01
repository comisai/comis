// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildDynamicPreamble,
  renderRecentUserContinuitySection,
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

  it("retains bounded prior user requests for elliptical follow-ups", () => {
    const section = renderRecentUserContinuitySection([
      "an older unrelated request",
      "find a procedure for the task we just discussed",
      "the immediately preceding user request",
    ]);

    expect(section).toContain("## Recent User Requests");
    expect(section).toContain("context-dependent references and elliptical follow-ups");
    expect(section).not.toContain("an older unrelated request");
    expect(section).toContain("find a procedure for the task we just discussed");
    expect(section).toContain("the immediately preceding user request");
    expect(section).toContain("UNTRUSTED_");
  });
});
