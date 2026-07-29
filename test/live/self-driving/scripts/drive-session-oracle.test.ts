// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { outboundVisibleText } from "./drive-session-oracle.mjs";

describe("drive outbound visibility", () => {
  it("treats an attachment caption as substantive user-visible text", () => {
    expect(outboundVisibleText({
      method: "sendDocument",
      messageId: 42,
      caption: "The requested transcript is attached.",
      mediaKind: "document",
    })).toBe("The requested transcript is attached.");
  });

  it("preserves ordinary message text and ignores an empty attachment caption", () => {
    expect(outboundVisibleText({
      method: "sendMessage",
      messageId: 43,
      text: "The answer",
    })).toBe("The answer");
    expect(outboundVisibleText({
      method: "sendDocument",
      messageId: 44,
      caption: "",
    })).toBe("");
  });
});
