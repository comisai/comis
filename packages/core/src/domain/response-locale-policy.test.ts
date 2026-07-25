// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  parseResponseLocalePolicy,
  ResponseLocalePolicySchema,
} from "./response-locale-policy.js";

describe("ResponseLocalePolicy", () => {
  it("accepts an open canonical BCP-47 locale", () => {
    const result = parseResponseLocalePolicy({
      locale: "zh-Hant-TW",
      source: "explicit",
      enforceLocale: true,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an unset policy without inventing a default locale", () => {
    expect(ResponseLocalePolicySchema.safeParse({
      source: "unset",
      enforceLocale: false,
    }).success).toBe(true);
  });

  it("rejects locale enforcement when no locale is known", () => {
    expect(ResponseLocalePolicySchema.safeParse({
      source: "unset",
      enforceLocale: true,
    }).success).toBe(false);
  });

  it("rejects malformed locale tags", () => {
    expect(ResponseLocalePolicySchema.safeParse({
      locale: "not_a_locale",
      source: "request",
      enforceLocale: false,
    }).success).toBe(false);
  });

  it("rejects workspace and conversation inference sources", () => {
    for (const source of ["workspace", "conversation"]) {
      expect(ResponseLocalePolicySchema.safeParse({
        locale: "en",
        source,
        enforceLocale: false,
      }).success).toBe(false);
    }
  });
});
