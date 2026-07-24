// SPDX-License-Identifier: Apache-2.0
import { HEARTBEAT_OK_TOKEN, NO_REPLY_TOKEN, SILENT_PREFIX } from "@comis/shared";
import { describe, expect, it } from "vitest";
import {
  classifyHeartbeatResponse,
  processHeartbeatResponse,
  stripHeartbeatToken,
  stripMarkup,
  stripResponsePrefix,
} from "./response-processor.js";

describe("heartbeat response normalization", () => {
  it("drops an unterminated HTML tag tail before classifying a heartbeat reply", () => {
    expect(stripMarkup("HEARTBEAT_OK<script")).toBe("HEARTBEAT_OK");
  });

  it("exposes a wrapped heartbeat token through bounded markup removal", () => {
    expect(stripMarkup("<p>**HEARTBEAT_OK**</p>")).toBe("HEARTBEAT_OK");
    expect(stripMarkup("  plain text  ")).toBe("plain text");
  });

  it("recognizes only leading trailing or exact heartbeat tokens", () => {
    expect(stripHeartbeatToken("HEARTBEAT_OK!!!")).toEqual({ stripped: "", hadToken: true });
    expect(stripHeartbeatToken("HEARTBEAT_OK. All clear.")).toEqual({
      stripped: "All clear.", hadToken: true,
    });
    expect(stripHeartbeatToken("All clear. HEARTBEAT_OK")).toEqual({
      stripped: "All clear.", hadToken: true,
    });
    expect(stripHeartbeatToken("The status is HEARTBEAT_OK for now")).toEqual({
      stripped: "The status is HEARTBEAT_OK for now", hadToken: false,
    });
    expect(stripHeartbeatToken("HEARTBEAT_OK!!!!!")).toEqual({
      stripped: "HEARTBEAT_OK!!!!!", hadToken: false,
    });
  });

  it("strips a configured response prefix case-sensitively", () => {
    expect(stripResponsePrefix("Agent: hello", "Agent: ")).toBe("hello");
    expect(stripResponsePrefix("agent: hello", "Agent: ")).toBe("agent: hello");
    expect(stripResponsePrefix("hello", undefined)).toBe("hello");
  });
});

describe("closed heartbeat response classification", () => {
  it("classifies empty output without manufacturing a visible acknowledgement", () => {
    for (const text of [null, undefined, "   \n  "]) {
      expect(classifyHeartbeatResponse({ text, hasMedia: false, ackMaxChars: 300 })).toEqual({
        kind: "empty",
      });
    }
  });

  it("suppresses shared non-heartbeat silent markers after reply-tag normalization", () => {
    for (const text of [
      NO_REPLY_TOKEN,
      `  <reply>  ${NO_REPLY_TOKEN}  </reply>  `,
      `${SILENT_PREFIX} no user notification needed`,
      `<reply>${SILENT_PREFIX} no user notification needed</reply>`,
    ]) {
      expect(classifyHeartbeatResponse({ text, hasMedia: false, ackMaxChars: 300 })).toEqual({
        kind: "empty",
      });
    }
  });

  it("maps a token-only response to the canonical visible token", () => {
    expect(classifyHeartbeatResponse({
      text: "<p>HEARTBEAT_OK</p>", hasMedia: false, ackMaxChars: 300,
    })).toEqual({
      kind: "acknowledged_ok",
      reason: "heartbeat_token",
      text: HEARTBEAT_OK_TOKEN,
    });
  });

  it("keeps the exact stripped residual only when a token bounds a short acknowledgement", () => {
    expect(classifyHeartbeatResponse({
      text: "HEARTBEAT_OK. All clear.", hasMedia: false, ackMaxChars: 10,
    })).toEqual({
      kind: "acknowledged_ok",
      reason: "ack_under_threshold",
      text: "All clear.",
    });
  });

  it("does not suppress arbitrary short text without the heartbeat token", () => {
    expect(classifyHeartbeatResponse({
      text: "All clear.", hasMedia: false, ackMaxChars: 300,
    })).toEqual({
      kind: "alert",
      level: "alert",
      text: "All clear.",
      hasMedia: false,
    });
  });

  it("delivers a token residual that exceeds the acknowledgement threshold", () => {
    const text = "A".repeat(11);
    expect(classifyHeartbeatResponse({
      text: `HEARTBEAT_OK\n\n${text}`, hasMedia: false, ackMaxChars: 10,
    })).toEqual({ kind: "alert", level: "alert", text, hasMedia: false });
  });

  it("gives critical content precedence over an embedded heartbeat token", () => {
    expect(classifyHeartbeatResponse({
      text: "HEARTBEAT_OK. CRITICAL: disk full", hasMedia: false, ackMaxChars: 300,
    })).toEqual({
      kind: "alert",
      level: "critical",
      text: "CRITICAL: disk full",
      hasMedia: false,
    });
  });

  it("keeps media visible even when its text is an acknowledgement token", () => {
    expect(classifyHeartbeatResponse({
      text: "HEARTBEAT_OK", hasMedia: true, ackMaxChars: 300,
    })).toEqual({
      kind: "alert",
      level: "alert",
      text: "HEARTBEAT_OK",
      hasMedia: true,
    });
    expect(classifyHeartbeatResponse({
      text: NO_REPLY_TOKEN, hasMedia: true, ackMaxChars: 300,
    })).toEqual({
      kind: "alert",
      level: "alert",
      text: NO_REPLY_TOKEN,
      hasMedia: true,
    });
  });

  it("applies response prefix removal before all closed classification", () => {
    expect(processHeartbeatResponse({
      responseText: "Agent: HEARTBEAT_OK. Routine",
      responsePrefix: "Agent: ",
      ackMaxChars: 20,
      hasMedia: false,
    })).toEqual({
      kind: "acknowledged_ok",
      reason: "ack_under_threshold",
      text: "Routine",
    });
  });
});
