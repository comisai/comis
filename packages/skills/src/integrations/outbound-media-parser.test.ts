import { describe, it, expect } from "vitest";
import { parseOutboundMedia } from "./outbound-media-parser.js";

describe("parseOutboundMedia", () => {
  it("returns text unchanged and empty mediaUrls when no directives present", () => {
    const input = "Here is some text.\nNo media here.";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("Here is some text.\nNo media here.");
    expect(result.mediaUrls).toEqual([]);
  });

  it("extracts a single MEDIA: https URL and removes the line", () => {
    const input = "Here is an image:\nMEDIA: https://example.com/image.png\nEnjoy!";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("Here is an image:\nEnjoy!");
    expect(result.mediaUrls).toEqual(["https://example.com/image.png"]);
  });

  it("extracts multiple MEDIA: lines", () => {
    const input = [
      "Check these out:",
      "MEDIA: https://example.com/a.png",
      "MEDIA: https://example.com/b.jpg",
      "MEDIA: http://cdn.example.com/c.gif",
      "Done!",
    ].join("\n");
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("Check these out:\nDone!");
    expect(result.mediaUrls).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.jpg",
      "http://cdn.example.com/c.gif",
    ]);
  });

  it("extracts backtick-wrapped URLs", () => {
    const input = "MEDIA: `https://example.com/wrapped.png`";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("");
    expect(result.mediaUrls).toEqual(["https://example.com/wrapped.png"]);
  });

  it("handles mixed content with text paragraphs and MEDIA: lines", () => {
    const input = [
      "First paragraph of text.",
      "",
      "MEDIA: https://example.com/chart.png",
      "",
      "Second paragraph explaining the chart.",
      "MEDIA: https://example.com/data.csv",
      "",
      "Conclusion.",
    ].join("\n");
    const result = parseOutboundMedia(input);
    expect(result.text).toBe(
      "First paragraph of text.\n\n\nSecond paragraph explaining the chart.\n\nConclusion."
    );
    expect(result.mediaUrls).toEqual([
      "https://example.com/chart.png",
      "https://example.com/data.csv",
    ]);
  });

  it("keeps non-URL MEDIA: line in output text", () => {
    const input = "MEDIA: just some text\nOther line.";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("MEDIA: just some text\nOther line.");
    expect(result.mediaUrls).toEqual([]);
  });

  it("handles case variations (MEDIA:, media:, Media:)", () => {
    const input = [
      "media: https://example.com/lower.png",
      "Media: https://example.com/title.png",
      "MEDIA: https://example.com/upper.png",
    ].join("\n");
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("");
    expect(result.mediaUrls).toEqual([
      "https://example.com/lower.png",
      "https://example.com/title.png",
      "https://example.com/upper.png",
    ]);
  });

  it("handles whitespace around directive and URL", () => {
    const input = "  MEDIA:   https://example.com/spaced.png  ";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("");
    expect(result.mediaUrls).toEqual(["https://example.com/spaced.png"]);
  });

  it("extracts absolute filesystem path", () => {
    const input = "MEDIA: /tmp/chart.png";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("");
    expect(result.mediaUrls).toEqual(["/tmp/chart.png"]);
  });

  it("does NOT extract relative path without /", () => {
    const input = "MEDIA: chart.png";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("MEDIA: chart.png");
    expect(result.mediaUrls).toEqual([]);
  });

  it("returns empty text and empty mediaUrls for empty string input", () => {
    const result = parseOutboundMedia("");
    expect(result.text).toBe("");
    expect(result.mediaUrls).toEqual([]);
  });

  it("extracts http:// URLs", () => {
    const input = "MEDIA: http://insecure.example.com/img.jpg";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("");
    expect(result.mediaUrls).toEqual(["http://insecure.example.com/img.jpg"]);
  });

  it("trims trailing whitespace from output text", () => {
    const input = "Hello\nMEDIA: https://example.com/img.png\n\n  ";
    const result = parseOutboundMedia(input);
    expect(result.text).toBe("Hello");
    expect(result.mediaUrls).toEqual(["https://example.com/img.png"]);
  });
});
