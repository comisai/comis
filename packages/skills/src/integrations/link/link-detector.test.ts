// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for URL detection and extraction from messages.
 */

import { describe, it, expect } from "vitest";
import { extractLinksFromMessage } from "./link-detector.js";

// ---------------------------------------------------------------------------
// extractLinksFromMessage
// ---------------------------------------------------------------------------

describe("extractLinksFromMessage", () => {
  it("extracts bare URLs", () => {
    const result = extractLinksFromMessage("Check https://example.com for more info");

    expect(result).toHaveLength(1);
    expect(result[0]).toBe("https://example.com/");
  });

  it("strips markdown links before extraction to avoid duplication", () => {
    const result = extractLinksFromMessage(
      "[click here](https://example.com) and also https://other.com",
    );

    // Both URLs should be extracted: markdown link URL + bare URL
    expect(result).toHaveLength(2);
    expect(result).toContain("https://example.com/");
    expect(result).toContain("https://other.com/");
  });

  it("deduplicates URLs", () => {
    const result = extractLinksFromMessage(
      "Visit https://example.com and again https://example.com",
    );

    expect(result).toHaveLength(1);
  });

  it("respects maxLinks", () => {
    const text = [
      "https://one.com",
      "https://two.com",
      "https://three.com",
      "https://four.com",
      "https://five.com",
    ].join(" ");

    const result = extractLinksFromMessage(text, 2);

    expect(result).toHaveLength(2);
  });

  it("trims trailing punctuation", () => {
    const result = extractLinksFromMessage("Visit https://example.com.");

    expect(result).toHaveLength(1);
    // URL should have trailing period removed
    expect(result[0]).toBe("https://example.com/");
  });

  it("skips localhost and private IPs", () => {
    const result = extractLinksFromMessage(
      "Try http://127.0.0.1/admin and http://localhost:3000/api",
    );

    expect(result).toHaveLength(0);
  });

  it("skips RFC 1918 private range IPs", () => {
    const result = extractLinksFromMessage(
      "http://10.0.0.1/secret http://192.168.1.1/config http://172.16.0.1/admin",
    );

    expect(result).toHaveLength(0);
  });

  it("skips invalid URLs", () => {
    const result = extractLinksFromMessage("Not a URL: https://");

    expect(result).toHaveLength(0);
  });

  it("handles empty string", () => {
    const result = extractLinksFromMessage("");

    expect(result).toHaveLength(0);
  });

  it("extracts multiple different URLs up to maxLinks", () => {
    const text = "Visit https://example.com and https://example.org for info";
    const result = extractLinksFromMessage(text, 3);

    expect(result).toHaveLength(2);
    expect(result).toContain("https://example.com/");
    expect(result).toContain("https://example.org/");
  });

  it("handles URLs with paths and query params", () => {
    const result = extractLinksFromMessage(
      "See https://example.com/page?q=test&page=1#section",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("example.com/page");
    expect(result[0]).toContain("q=test");
  });

  it("skips link-local addresses", () => {
    const result = extractLinksFromMessage("http://169.254.169.254/latest/meta-data");

    expect(result).toHaveLength(0);
  });
});
