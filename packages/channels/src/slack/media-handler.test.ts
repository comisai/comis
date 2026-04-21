// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SlackFile } from "./message-mapper.js";
import { buildSlackAttachments, isSlackHostname, fetchWithSlackAuth } from "./media-handler.js";

describe("media-handler", () => {
  describe("buildSlackAttachments", () => {
    it("returns empty array for undefined files", () => {
      expect(buildSlackAttachments(undefined)).toEqual([]);
    });

    it("returns empty array for empty files array", () => {
      expect(buildSlackAttachments([])).toEqual([]);
    });

    it("maps image file to type 'image' with slack-file:// URL", () => {
      const files: SlackFile[] = [
        {
          id: "F001",
          name: "photo.png",
          mimetype: "image/png",
          size: 12345,
        },
      ];

      const result = buildSlackAttachments(files);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: "image",
        url: "slack-file://F001",
        mimeType: "image/png",
        fileName: "photo.png",
        sizeBytes: 12345,
      });
    });

    it("maps audio file to type 'audio'", () => {
      const files: SlackFile[] = [{ id: "F002", mimetype: "audio/mpeg" }];

      const result = buildSlackAttachments(files);

      expect(result[0].type).toBe("audio");
    });

    it("maps video file to type 'video'", () => {
      const files: SlackFile[] = [{ id: "F003", mimetype: "video/mp4" }];

      const result = buildSlackAttachments(files);

      expect(result[0].type).toBe("video");
    });

    it("maps unknown mimetype to type 'file'", () => {
      const files: SlackFile[] = [{ id: "F004", mimetype: "application/pdf" }];

      const result = buildSlackAttachments(files);

      expect(result[0].type).toBe("file");
    });

    it("maps file with no mimetype to type 'file'", () => {
      const files: SlackFile[] = [{ id: "F005" }];

      const result = buildSlackAttachments(files);

      expect(result[0].type).toBe("file");
      expect(result[0].url).toBe("slack-file://F005");
    });

    it("preserves file attributes (name, size, mimetype)", () => {
      const files: SlackFile[] = [
        {
          id: "F006",
          name: "report.xlsx",
          mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 98765,
        },
      ];

      const result = buildSlackAttachments(files);

      expect(result[0].fileName).toBe("report.xlsx");
      expect(result[0].sizeBytes).toBe(98765);
      expect(result[0].mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });

    it("handles multiple files", () => {
      const files: SlackFile[] = [
        { id: "F001", mimetype: "image/jpeg" },
        { id: "F002", mimetype: "audio/wav" },
        { id: "F003", mimetype: "video/webm" },
      ];

      const result = buildSlackAttachments(files);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("image");
      expect(result[1].type).toBe("audio");
      expect(result[2].type).toBe("video");
    });

    it("omits optional fields when not present on SlackFile", () => {
      const files: SlackFile[] = [{ id: "F007" }];

      const result = buildSlackAttachments(files);

      expect(result[0]).toEqual({
        type: "file",
        url: "slack-file://F007",
      });
      expect(result[0]).not.toHaveProperty("mimeType");
      expect(result[0]).not.toHaveProperty("fileName");
      expect(result[0]).not.toHaveProperty("sizeBytes");
    });
  });

  describe("isSlackHostname", () => {
    it("returns true for slack.com", () => {
      expect(isSlackHostname("slack.com")).toBe(true);
    });

    it("returns true for files.slack.com", () => {
      expect(isSlackHostname("files.slack.com")).toBe(true);
    });

    it("returns true for a.b.slack.com", () => {
      expect(isSlackHostname("a.b.slack.com")).toBe(true);
    });

    it("returns true for slack-edge.com", () => {
      expect(isSlackHostname("slack-edge.com")).toBe(true);
    });

    it("returns true for cdn.slack-edge.com", () => {
      expect(isSlackHostname("cdn.slack-edge.com")).toBe(true);
    });

    it("returns true for slack-files.com", () => {
      expect(isSlackHostname("slack-files.com")).toBe(true);
    });

    it("returns false for evil.com", () => {
      expect(isSlackHostname("evil.com")).toBe(false);
    });

    it("returns false for notslack.com", () => {
      expect(isSlackHostname("notslack.com")).toBe(false);
    });

    it("returns false for slack.com.evil.com", () => {
      expect(isSlackHostname("slack.com.evil.com")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isSlackHostname("")).toBe(false);
    });

    it("handles case-insensitive hostnames", () => {
      expect(isSlackHostname("Files.SLACK.com")).toBe(true);
    });

    it("handles trailing dot in hostname", () => {
      expect(isSlackHostname("files.slack.com.")).toBe(true);
    });
  });

  describe("fetchWithSlackAuth", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("rejects non-HTTPS URLs", async () => {
      await expect(
        fetchWithSlackAuth("http://files.slack.com/file.txt", "xoxb-token"),
      ).rejects.toThrow("non-HTTPS");
    });

    it("rejects non-Slack hostnames", async () => {
      await expect(fetchWithSlackAuth("https://evil.com/file.txt", "xoxb-token")).rejects.toThrow(
        "non-Slack host",
      );
    });

    it("sends auth header on initial request with manual redirect", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });
      globalThis.fetch = mockFetch;

      await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://files.slack.com/file.txt");
      expect(opts.headers.Authorization).toBe("Bearer xoxb-token");
      expect(opts.redirect).toBe("manual");
    });

    it("returns response directly for non-redirect status", async () => {
      const mockResponse = { status: 200, headers: new Headers() };
      globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse);

      const result = await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

      expect(result).toBe(mockResponse);
    });

    it("follows redirect without auth header", async () => {
      const redirectHeaders = new Headers();
      redirectHeaders.set("location", "https://cdn.slack-edge.com/signed-file");

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: redirectHeaders,
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers(),
        });
      globalThis.fetch = mockFetch;

      await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

      // Second call should NOT have Authorization header
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [redirectUrl, redirectOpts] = mockFetch.mock.calls[1];
      expect(redirectUrl).toBe("https://cdn.slack-edge.com/signed-file");
      expect(redirectOpts).not.toHaveProperty("headers");
      expect(redirectOpts.redirect).toBe("follow");
    });

    it("returns initial response when redirect has no Location header", async () => {
      const mockResponse = { status: 302, headers: new Headers() };
      globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse);

      const result = await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

      expect(result).toBe(mockResponse);
    });

    it("returns initial response when redirect URL is not HTTPS", async () => {
      const redirectHeaders = new Headers();
      redirectHeaders.set("location", "http://insecure.example.com/file");

      const mockResponse = { status: 302, headers: redirectHeaders };
      globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse);

      const result = await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

      expect(result).toBe(mockResponse);
    });

    it("resolves relative redirect URLs against original URL", async () => {
      const redirectHeaders = new Headers();
      redirectHeaders.set("location", "/redirect-path");

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          status: 301,
          headers: redirectHeaders,
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers(),
        });
      globalThis.fetch = mockFetch;

      await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

      const [redirectUrl] = mockFetch.mock.calls[1];
      expect(redirectUrl).toBe("https://files.slack.com/redirect-path");
    });

    // Redirect hostname re-validation tests
    describe("redirect hostname validation", () => {
      it("follows redirect to files.slack.com", async () => {
        const redirectHeaders = new Headers();
        redirectHeaders.set("location", "https://files.slack.com/signed-file");

        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce({ status: 302, headers: redirectHeaders })
          .mockResolvedValueOnce({ status: 200, headers: new Headers() });
        globalThis.fetch = mockFetch;

        await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [redirectUrl] = mockFetch.mock.calls[1];
        expect(redirectUrl).toBe("https://files.slack.com/signed-file");
      });

      it("follows redirect to slack-edge.com", async () => {
        const redirectHeaders = new Headers();
        redirectHeaders.set("location", "https://cdn.slack-edge.com/signed-file");

        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce({ status: 302, headers: redirectHeaders })
          .mockResolvedValueOnce({ status: 200, headers: new Headers() });
        globalThis.fetch = mockFetch;

        await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("follows redirect to cdn.slack-files.com", async () => {
        const redirectHeaders = new Headers();
        redirectHeaders.set("location", "https://cdn.slack-files.com/signed-file");

        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce({ status: 302, headers: redirectHeaders })
          .mockResolvedValueOnce({ status: 200, headers: new Headers() });
        globalThis.fetch = mockFetch;

        await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("throws error when redirect targets evil.example.com", async () => {
        const redirectHeaders = new Headers();
        redirectHeaders.set("location", "https://evil.example.com/steal-data");

        globalThis.fetch = vi
          .fn()
          .mockResolvedValueOnce({ status: 302, headers: redirectHeaders });

        await expect(
          fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token"),
        ).rejects.toThrow("non-Slack host");
      });

      it("throws error when redirect targets slack.com.evil.com (suffix attack)", async () => {
        const redirectHeaders = new Headers();
        redirectHeaders.set("location", "https://slack.com.evil.com/steal");

        globalThis.fetch = vi
          .fn()
          .mockResolvedValueOnce({ status: 302, headers: redirectHeaders });

        await expect(
          fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token"),
        ).rejects.toThrow("non-Slack host");
      });

      it("returns initial response directly for 200 (no redirect)", async () => {
        const mockResponse = { status: 200, headers: new Headers() };
        globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse);

        const result = await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");
        expect(result).toBe(mockResponse);
      });

      it("does not follow redirect with non-HTTPS protocol", async () => {
        const redirectHeaders = new Headers();
        redirectHeaders.set("location", "http://cdn.slack-edge.com/file");

        const mockResponse = { status: 302, headers: redirectHeaders };
        globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse);

        const result = await fetchWithSlackAuth("https://files.slack.com/file.txt", "xoxb-token");
        expect(result).toBe(mockResponse);
      });
    });
  });
});

// Need to import afterEach explicitly
import { afterEach } from "vitest";
