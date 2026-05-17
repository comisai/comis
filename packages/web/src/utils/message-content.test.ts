// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the message-content utility module.
 *
 * Covers stripSilentTokens / stripUserSystemContext / cleanMessageContent. Pure-function
 * transforms with role-based dispatch and regex matching. Every branch of the channel
 * header regex + fast-path / end-marker / fallback paths is exercised.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  stripSilentTokens,
  stripUserSystemContext,
  cleanMessageContent,
} from "./message-content.js";

describe("stripSilentTokens", () => {
  it("removes a standalone NO_REPLY token leaving the surrounding text intact", () => {
    expect(stripSilentTokens("Hello NO_REPLY world")).toBe("Hello  world");
  });

  it("removes a standalone HEARTBEAT_OK token from response text", () => {
    expect(stripSilentTokens("Status HEARTBEAT_OK ok")).toBe("Status  ok");
  });

  it("removes both NO_REPLY and HEARTBEAT_OK tokens in a single pass", () => {
    expect(stripSilentTokens("NO_REPLY before HEARTBEAT_OK after")).toBe("before  after");
  });

  it("trims surrounding whitespace after token removal from response text", () => {
    expect(stripSilentTokens("  NO_REPLY  ")).toBe("");
  });

  it("preserves substrings that merely contain the token characters without word boundaries", () => {
    expect(stripSilentTokens("NO_REPLY_HANDLER")).toBe("NO_REPLY_HANDLER");
  });

  it("returns empty string when input is empty for safe pass-through", () => {
    expect(stripSilentTokens("")).toBe("");
  });

  it("returns input unchanged when no silent tokens are present in the message", () => {
    expect(stripSilentTokens("just a regular message")).toBe("just a regular message");
  });
});

describe("stripUserSystemContext", () => {
  it("returns input unchanged via fast path when neither system-context marker is present", () => {
    const text = "[telegram] 1234 (9:00 AM):\nHello there";
    expect(stripUserSystemContext(text)).toBe(text);
  });

  it("extracts the actual user message after [End system context] + channel header", () => {
    const text =
      "[System context] context goes here [End system context]\n[telegram] 678314278 (9:34 AM):\nHello";
    expect(stripUserSystemContext(text)).toBe("Hello");
  });

  it("handles channel headers from arbitrary platform names matching [word-with-dashes]", () => {
    const text =
      "[System context] x [End system context]\n[whats-app] 555 (10:00 AM):\nWhat is up";
    expect(stripUserSystemContext(text)).toBe("What is up");
  });

  it("returns trimmed content after the end-marker when channel header regex does not match", () => {
    const text = "[System context] foo [End system context]\n\n  bare message\n";
    expect(stripUserSystemContext(text)).toBe("bare message");
  });

  it("returns the original text when [End system context] marker is missing despite [System context]", () => {
    const text = "[System context] foo\n[telegram] 1234 (9:34 AM):\nHello";
    // Both markers must be considered; missing end marker keeps text unchanged when lastIndexOf returns -1
    // However the function's fast-path only triggers if BOTH are absent; here [System context] is present,
    // [End system context] is not — so it goes into the slow path and endIdx === -1, returns text unchanged.
    expect(stripUserSystemContext(text)).toBe(text);
  });

  it("uses the LAST occurrence of [End system context] when the marker repeats in content", () => {
    const text =
      "[System context] a [End system context]\nsome filler\n[End system context]\n[discord] u (1:00 PM):\nLast";
    expect(stripUserSystemContext(text)).toBe("Last");
  });
});

describe("cleanMessageContent", () => {
  it("strips silent tokens when role is assistant per the assistant cleanup branch", () => {
    expect(cleanMessageContent("Hi NO_REPLY", "assistant")).toBe("Hi");
  });

  it("strips user system context when role is user per the user cleanup branch", () => {
    const text =
      "[System context] sys [End system context]\n[slack] u (8:00 AM):\nHello world";
    expect(cleanMessageContent(text, "user")).toBe("Hello world");
  });

  it("returns input unchanged when role is neither assistant nor user (e.g. system, tool)", () => {
    const text = "raw system message with NO_REPLY inside";
    expect(cleanMessageContent(text, "system")).toBe(text);
    expect(cleanMessageContent(text, "tool")).toBe(text);
  });
});
