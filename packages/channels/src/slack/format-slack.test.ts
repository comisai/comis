// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { escapeSlackMrkdwn } from "./format-slack.js";

describe("format-slack", () => {
  describe("escapeSlackMrkdwn", () => {
    it("escapes & to &amp;", () => {
      expect(escapeSlackMrkdwn("foo & bar")).toBe("foo &amp; bar");
    });

    it("escapes < to &lt;", () => {
      expect(escapeSlackMrkdwn("a < b")).toBe("a &lt; b");
    });

    it("escapes > to &gt;", () => {
      expect(escapeSlackMrkdwn("a > b")).toBe("a &gt; b");
    });

    it("preserves Slack user mentions <@U123>", () => {
      expect(escapeSlackMrkdwn("Hello <@U123ABC>!")).toBe("Hello <@U123ABC>!");
    });

    it("preserves Slack channel mentions <#C123>", () => {
      expect(escapeSlackMrkdwn("See <#C123DEF>")).toBe("See <#C123DEF>");
    });

    it("preserves Slack special mentions <!here>", () => {
      expect(escapeSlackMrkdwn("Hey <!here>")).toBe("Hey <!here>");
    });

    it("preserves Slack URLs <https://example.com>", () => {
      expect(escapeSlackMrkdwn("Visit <https://example.com>")).toBe("Visit <https://example.com>");
    });

    it("preserves Slack URL with label <https://example.com|Link>", () => {
      expect(escapeSlackMrkdwn("Click <https://example.com|here>")).toBe(
        "Click <https://example.com|here>",
      );
    });

    it("preserves slack:// protocol links", () => {
      expect(escapeSlackMrkdwn("<slack://open>")).toBe("<slack://open>");
    });

    it("escapes unrecognized angle-bracket tokens", () => {
      expect(escapeSlackMrkdwn("<script>alert</script>")).toBe(
        "&lt;script&gt;alert&lt;/script&gt;",
      );
    });

    it("returns text unchanged when no special characters", () => {
      expect(escapeSlackMrkdwn("hello world")).toBe("hello world");
    });

    it("handles multiple escapes in one string", () => {
      expect(escapeSlackMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    });
  });

});
