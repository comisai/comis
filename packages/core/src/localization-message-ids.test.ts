// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DETERMINISTIC_LOCALIZATION_MESSAGE_IDS } from "./localization-message-ids.js";

describe("deterministic localization message ids", () => {
  it("keeps every operator locale-pack identifier unique", () => {
    expect(new Set(DETERMINISTIC_LOCALIZATION_MESSAGE_IDS).size)
      .toBe(DETERMINISTIC_LOCALIZATION_MESSAGE_IDS.length);
  });

  it("uses outcome-specific identifiers for approval decisions", () => {
    expect(DETERMINISTIC_LOCALIZATION_MESSAGE_IDS).toContain(
      "approval.resolved_one.approved",
    );
    expect(DETERMINISTIC_LOCALIZATION_MESSAGE_IDS).toContain(
      "approval.resolved_one.denied",
    );
  });

  it("publishes every deterministic attention reply identifier", () => {
    expect(DETERMINISTIC_LOCALIZATION_MESSAGE_IDS).toEqual(expect.arrayContaining([
      "attention.response_bound",
      "attention.multiple",
      "attention.not_found",
      "attention.already_answered",
      "attention.usage",
      "attention.unavailable",
    ]));
  });
});
