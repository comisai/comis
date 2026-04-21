// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { filterResponse, NO_REPLY_TOKEN } from "./response-filter.js";

describe("filterResponse", () => {
  // -------------------------------------------------------------------------
  // Suppression: empty / whitespace
  // -------------------------------------------------------------------------

  it("suppresses empty string", () => {
    const result = filterResponse("");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "empty" });
  });

  it("suppresses whitespace-only string", () => {
    const result = filterResponse("   \n\t  ");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "empty" });
  });

  it("suppresses null/undefined input (cast edge case)", () => {
    const result = filterResponse(null as unknown as string);
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "empty" });

    const result2 = filterResponse(undefined as unknown as string);
    expect(result2).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "empty" });
  });

  // -------------------------------------------------------------------------
  // Suppression: NO_REPLY
  // -------------------------------------------------------------------------

  it("suppresses exact NO_REPLY", () => {
    const result = filterResponse("NO_REPLY");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "NO_REPLY" });
  });

  it("suppresses NO_REPLY with surrounding whitespace", () => {
    const result = filterResponse("  NO_REPLY  \n");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "NO_REPLY" });
  });

  // -------------------------------------------------------------------------
  // Suppression: HEARTBEAT_OK
  // -------------------------------------------------------------------------

  it("suppresses exact HEARTBEAT_OK", () => {
    const result = filterResponse("HEARTBEAT_OK");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "HEARTBEAT_OK" });
  });

  it("suppresses HEARTBEAT_OK with surrounding whitespace", () => {
    const result = filterResponse("\t HEARTBEAT_OK \n");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "HEARTBEAT_OK" });
  });

  // -------------------------------------------------------------------------
  // Reply tag stripping
  // -------------------------------------------------------------------------

  it("strips <reply> tags and delivers inner content", () => {
    const result = filterResponse("<reply>Hello world</reply>");
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("Hello world");
  });

  it("strips <reply to=\"...\"> tags and delivers inner content", () => {
    const result = filterResponse('<reply to="channel-123">Hello world</reply>');
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("Hello world");
  });

  it("suppresses HEARTBEAT_OK wrapped in reply tags", () => {
    const result = filterResponse("<reply>HEARTBEAT_OK</reply>");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "HEARTBEAT_OK" });
  });

  it("suppresses NO_REPLY wrapped in reply tags", () => {
    const result = filterResponse("<reply>NO_REPLY</reply>");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "NO_REPLY" });
  });

  it("strips reply tags from multiline response", () => {
    const result = filterResponse("<reply>Line one\nLine two</reply>");
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("Line one\nLine two");
  });

  it("suppresses empty reply tags", () => {
    const result = filterResponse("<reply></reply>");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "empty" });
  });

  // -------------------------------------------------------------------------
  // Suppression: [SILENT] prefix
  // -------------------------------------------------------------------------

  it("suppresses [SILENT] exact token", () => {
    const result = filterResponse("[SILENT]");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "SILENT" });
  });

  it("suppresses [SILENT] with trailing text", () => {
    const result = filterResponse("[SILENT] nothing new to report");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "SILENT" });
  });

  it("suppresses [SILENT] with surrounding whitespace", () => {
    const result = filterResponse("  [SILENT]  ");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "SILENT" });
  });

  it("suppresses [silent] lowercase (case-insensitive)", () => {
    const result = filterResponse("[silent]");
    expect(result).toEqual({ shouldDeliver: false, cleanedText: "", suppressedBy: "SILENT" });
  });

  it("does NOT suppress [SILENT] when not at start of response", () => {
    const result = filterResponse("I mentioned [SILENT] in my text");
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("I mentioned [SILENT] in my text");
  });

  // -------------------------------------------------------------------------
  // Delivery: normal text
  // -------------------------------------------------------------------------

  it("delivers normal text response", () => {
    const result = filterResponse("Hello world");
    expect(result).toEqual({ shouldDeliver: true, cleanedText: "Hello world" });
    expect(result.suppressedBy).toBeUndefined();
  });

  it("delivers response containing NO_REPLY as substring", () => {
    const result = filterResponse("I'll explain NO_REPLY tokens");
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("I'll explain NO_REPLY tokens");
  });

  it("delivers response containing HEARTBEAT_OK as substring", () => {
    const result = filterResponse("The system returned HEARTBEAT_OK which means all clear");
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("The system returned HEARTBEAT_OK which means all clear");
  });

  it("delivers multi-line response", () => {
    const result = filterResponse("Line one\nLine two\nLine three");
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("Line one\nLine two\nLine three");
  });

  it("trims whitespace from delivered responses", () => {
    const result = filterResponse("  Hello world  ");
    expect(result.shouldDeliver).toBe(true);
    expect(result.cleanedText).toBe("Hello world");
  });

  // -------------------------------------------------------------------------
  // Exported constant
  // -------------------------------------------------------------------------

  it("exports NO_REPLY_TOKEN constant", () => {
    expect(NO_REPLY_TOKEN).toBe("NO_REPLY");
  });
});
