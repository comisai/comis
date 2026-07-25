// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  CONTINUATION_USER_MESSAGE,
  REDACTED_TOOL_RESULT_USER_MESSAGE,
  isSyntheticSessionUserMessage,
} from "./synthetic-user-messages.js";

describe("isSyntheticSessionUserMessage", () => {
  it.each([
    CONTINUATION_USER_MESSAGE,
    REDACTED_TOOL_RESULT_USER_MESSAGE,
  ])("recognizes the exact SDK-generated placeholder %s", (text) => {
    expect(isSyntheticSessionUserMessage(`\n${text}\n`)).toBe(true);
  });

  it("preserves user text that only resembles an SDK placeholder", () => {
    expect(isSyntheticSessionUserMessage("continued from my previous message"))
      .toBe(false);
  });
});
