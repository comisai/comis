// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  stripMarkup,
  stripHeartbeatToken,
  stripResponsePrefix,
  classifyHeartbeatResponse,
  processHeartbeatResponse,
} from "./response-processor.js";
import type { HeartbeatResponseOutcome } from "./response-processor.js";

// ---------------------------------------------------------------------------
// stripMarkup
// ---------------------------------------------------------------------------

describe("stripMarkup", () => {
  it("strips HTML tags", () => {
    expect(stripMarkup("<p>HEARTBEAT_OK</p>")).toBe("HEARTBEAT_OK");
  });

  it("strips nested HTML tags", () => {
    expect(stripMarkup("<div><span>hello</span></div>")).toBe("hello");
  });

  it("strips bold markdown wrappers", () => {
    expect(stripMarkup("**HEARTBEAT_OK**")).toBe("HEARTBEAT_OK");
  });

  it("strips italic markdown wrappers", () => {
    expect(stripMarkup("*HEARTBEAT_OK*")).toBe("HEARTBEAT_OK");
  });

  it("strips backtick markdown wrappers", () => {
    expect(stripMarkup("`HEARTBEAT_OK`")).toBe("HEARTBEAT_OK");
  });

  it("strips strikethrough markdown wrappers", () => {
    expect(stripMarkup("~~HEARTBEAT_OK~~")).toBe("HEARTBEAT_OK");
  });

  it("strips underscore italic wrappers", () => {
    expect(stripMarkup("_HEARTBEAT_OK_")).toBe("HEARTBEAT_OK");
  });

  it("leaves plain text unchanged", () => {
    expect(stripMarkup("plain text")).toBe("plain text");
  });

  it("trims whitespace", () => {
    expect(stripMarkup("  HEARTBEAT_OK  ")).toBe("HEARTBEAT_OK");
  });

  it("handles combined HTML and markdown", () => {
    expect(stripMarkup("<b>**HEARTBEAT_OK**</b>")).toBe("HEARTBEAT_OK");
  });

  it("handles empty string", () => {
    expect(stripMarkup("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// stripHeartbeatToken
// ---------------------------------------------------------------------------

describe("stripHeartbeatToken", () => {
  it("detects exact token", () => {
    const result = stripHeartbeatToken("HEARTBEAT_OK");
    expect(result).toEqual({ stripped: "", hadToken: true });
  });

  it("detects token with trailing punctuation (up to 4 non-word chars)", () => {
    expect(stripHeartbeatToken("HEARTBEAT_OK!!!")).toEqual({ stripped: "", hadToken: true });
    expect(stripHeartbeatToken("HEARTBEAT_OK.")).toEqual({ stripped: "", hadToken: true });
    expect(stripHeartbeatToken("HEARTBEAT_OK..")).toEqual({ stripped: "", hadToken: true });
    expect(stripHeartbeatToken("HEARTBEAT_OK!!!!")).toEqual({ stripped: "", hadToken: true });
  });

  it("detects token with more than 4 trailing non-word chars as no-token", () => {
    // 5 trailing non-word chars -- exceeds allowance
    expect(stripHeartbeatToken("HEARTBEAT_OK!!!!!")).toEqual({
      stripped: "HEARTBEAT_OK!!!!!",
      hadToken: false,
    });
  });

  it("detects leading token with trailing text", () => {
    const result = stripHeartbeatToken("HEARTBEAT_OK. All clear.");
    expect(result).toEqual({ stripped: "All clear.", hadToken: true });
  });

  it("detects trailing token", () => {
    const result = stripHeartbeatToken("All clear. HEARTBEAT_OK");
    expect(result).toEqual({ stripped: "All clear.", hadToken: true });
  });

  it("does NOT detect token embedded mid-sentence", () => {
    const result = stripHeartbeatToken("The status is HEARTBEAT_OK for now");
    expect(result).toEqual({ stripped: "The status is HEARTBEAT_OK for now", hadToken: false });
  });

  it("returns no-token for text without token", () => {
    const result = stripHeartbeatToken("no token here");
    expect(result).toEqual({ stripped: "no token here", hadToken: false });
  });

  it("strips HTML before detecting token", () => {
    const result = stripHeartbeatToken("<p>HEARTBEAT_OK</p>");
    expect(result).toEqual({ stripped: "", hadToken: true });
  });

  it("strips markdown before detecting token", () => {
    const result = stripHeartbeatToken("**HEARTBEAT_OK**");
    expect(result).toEqual({ stripped: "", hadToken: true });
  });

  it("handles token with newline-separated trailing text", () => {
    const result = stripHeartbeatToken("HEARTBEAT_OK\n\nAll systems normal.");
    expect(result).toEqual({ stripped: "All systems normal.", hadToken: true });
  });
});

// ---------------------------------------------------------------------------
// stripResponsePrefix
// ---------------------------------------------------------------------------

describe("stripResponsePrefix", () => {
  it("strips matching prefix", () => {
    expect(stripResponsePrefix("Agent: hello world", "Agent: ")).toBe("hello world");
  });

  it("returns unchanged when prefix does not match", () => {
    expect(stripResponsePrefix("hello world", "Agent: ")).toBe("hello world");
  });

  it("returns unchanged when prefix is undefined", () => {
    expect(stripResponsePrefix("hello", undefined)).toBe("hello");
  });

  it("returns unchanged when prefix is empty", () => {
    expect(stripResponsePrefix("hello", "")).toBe("hello");
  });

  it("is case-sensitive", () => {
    expect(stripResponsePrefix("agent: hello", "Agent: ")).toBe("agent: hello");
  });
});

// ---------------------------------------------------------------------------
// classifyHeartbeatResponse
// ---------------------------------------------------------------------------

describe("classifyHeartbeatResponse", () => {
  it("returns empty_reply for null text", () => {
    const result = classifyHeartbeatResponse({ text: null, hasMedia: false, ackMaxChars: 300 });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "empty_reply", cleanedText: "" });
  });

  it("returns empty_reply for undefined text", () => {
    const result = classifyHeartbeatResponse({ text: undefined, hasMedia: false, ackMaxChars: 300 });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "empty_reply", cleanedText: "" });
  });

  it("returns empty_reply for whitespace-only text", () => {
    const result = classifyHeartbeatResponse({ text: "   \n  ", hasMedia: false, ackMaxChars: 300 });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "empty_reply", cleanedText: "" });
  });

  it("returns heartbeat_ok with reason token for exact HEARTBEAT_OK", () => {
    const result = classifyHeartbeatResponse({ text: "HEARTBEAT_OK", hasMedia: false, ackMaxChars: 300 });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "token", cleanedText: "" });
  });

  it("returns heartbeat_ok with token reason and cleaned text for short ack", () => {
    const result = classifyHeartbeatResponse({
      text: "HEARTBEAT_OK. All clear.",
      hasMedia: false,
      ackMaxChars: 300,
    });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "token", cleanedText: "All clear." });
  });

  it("returns deliver when token present but remaining text exceeds ackMaxChars", () => {
    const longText = "A".repeat(301);
    const result = classifyHeartbeatResponse({
      text: `HEARTBEAT_OK\n\n${longText}`,
      hasMedia: false,
      ackMaxChars: 300,
    });
    expect(result.kind).toBe("deliver");
    if (result.kind === "deliver") {
      expect(result.text).toBe(longText);
      expect(result.hasMedia).toBe(false);
    }
  });

  it("returns deliver for media attachments regardless of text", () => {
    const result = classifyHeartbeatResponse({ text: "some image", hasMedia: true, ackMaxChars: 300 });
    expect(result).toEqual({ kind: "deliver", text: "some image", hasMedia: true });
  });

  it("returns deliver for media even with HEARTBEAT_OK text", () => {
    const result = classifyHeartbeatResponse({ text: "HEARTBEAT_OK", hasMedia: true, ackMaxChars: 300 });
    expect(result).toEqual({ kind: "deliver", text: "HEARTBEAT_OK", hasMedia: true });
  });

  it("returns deliver for normal alert text", () => {
    const result = classifyHeartbeatResponse({
      text: "Alert: DB connection pool at 95%",
      hasMedia: false,
      ackMaxChars: 300,
    });
    expect(result.kind).toBe("deliver");
    if (result.kind === "deliver") {
      expect(result.text).toBe("Alert: DB connection pool at 95%");
      expect(result.hasMedia).toBe(false);
    }
  });

  it("returns heartbeat_ok for HTML-wrapped token", () => {
    const result = classifyHeartbeatResponse({
      text: "<p>HEARTBEAT_OK</p>",
      hasMedia: false,
      ackMaxChars: 300,
    });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "token", cleanedText: "" });
  });

  it("returns heartbeat_ok for markdown-wrapped token", () => {
    const result = classifyHeartbeatResponse({
      text: "**HEARTBEAT_OK**",
      hasMedia: false,
      ackMaxChars: 300,
    });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "token", cleanedText: "" });
  });

  it("respects custom ackMaxChars threshold", () => {
    // With ackMaxChars=5, "All clear." (10 chars) exceeds threshold -> deliver
    const result = classifyHeartbeatResponse({
      text: "HEARTBEAT_OK. All clear.",
      hasMedia: false,
      ackMaxChars: 5,
    });
    expect(result.kind).toBe("deliver");
    if (result.kind === "deliver") {
      expect(result.text).toBe("All clear.");
    }
  });
});

// ---------------------------------------------------------------------------
// processHeartbeatResponse
// ---------------------------------------------------------------------------

describe("processHeartbeatResponse", () => {
  it("applies prefix stripping before classification", () => {
    const result = processHeartbeatResponse({
      responseText: "Agent: HEARTBEAT_OK",
      responsePrefix: "Agent: ",
      ackMaxChars: 300,
      hasMedia: false,
    });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "token", cleanedText: "" });
  });

  it("classifies without prefix when none configured", () => {
    const result = processHeartbeatResponse({
      responseText: "HEARTBEAT_OK",
      responsePrefix: undefined,
      ackMaxChars: 300,
      hasMedia: false,
    });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "token", cleanedText: "" });
  });

  it("returns deliver for non-heartbeat text with prefix", () => {
    const result = processHeartbeatResponse({
      responseText: "Agent: Alert! Server down",
      responsePrefix: "Agent: ",
      ackMaxChars: 300,
      hasMedia: false,
    });
    expect(result.kind).toBe("deliver");
    if (result.kind === "deliver") {
      expect(result.text).toBe("Alert! Server down");
    }
  });

  it("handles null responseText", () => {
    const result = processHeartbeatResponse({
      responseText: null,
      responsePrefix: "Agent: ",
      ackMaxChars: 300,
      hasMedia: false,
    });
    expect(result).toEqual({ kind: "heartbeat_ok", reason: "empty_reply", cleanedText: "" });
  });

  it("media bypass takes precedence over prefix stripping", () => {
    const result = processHeartbeatResponse({
      responseText: "Agent: some image",
      responsePrefix: "Agent: ",
      ackMaxChars: 300,
      hasMedia: true,
    });
    expect(result.kind).toBe("deliver");
    if (result.kind === "deliver") {
      expect(result.hasMedia).toBe(true);
      // Prefix still stripped for delivery text
      expect(result.text).toBe("some image");
    }
  });
});
