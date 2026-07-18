// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  createLocaleCatalog,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
  selectOutputStarvedAnnotation,
} from "./degraded-reply-i18n.js";

describe("extensible locale catalog", () => {
  it("uses an application-supplied locale pack for any canonical BCP-47 tag", () => {
    const catalog = createLocaleCatalog({
      "fr-CA": {
        context_exhausted: "localized base ",
        advice_default: "localized advice",
        output_starved: "localized output limit",
        loop_detected: "localized loop",
      },
    });
    expect(selectContextExhaustedReply("fr-CA", {}, catalog)).toBe(
      "localized base localized advice",
    );
    expect(selectOutputStarvedAnnotation("fr-CA", catalog)).toBe("localized output limit");
    expect(selectLoopDetectedReply("fr-CA", {}, catalog)).toBe("localized loop");
  });

  it("falls back from a locale variant to an injected language pack", () => {
    const catalog = createLocaleCatalog({ fr: { output_starved: "language fallback" } });
    expect(selectOutputStarvedAnnotation("fr-CA", catalog)).toBe("language fallback");
  });

  it("uses the English platform pack for unknown or malformed locales", () => {
    expect(selectOutputStarvedAnnotation("qaa-Zzzz")).toContain("output limit");
    expect(selectOutputStarvedAnnotation("not a locale")).toContain("output limit");
  });

  it("never exposes internal configuration paths in user-facing messages", () => {
    expect(selectContextExhaustedReply(undefined, { capabilityClass: "small" }))
      .not.toContain("contextEngine.");
  });
});
