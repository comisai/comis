// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { AttachmentPayload, SendMessageOptions } from "@comis/core";
import {
  buildAttachmentReferenceBody,
  buildImageActivityBody,
  buildTextActivityBody,
  resolveReplyToId,
  resolveTypingServiceUrl,
  withTrailingSlash,
} from "../msteams-adapter-outbound.js";

describe("withTrailingSlash", () => {
  it("appends a single trailing slash to a bare service base url", () => {
    expect(withTrailingSlash("https://smba.trafficmanager.net/teams")).toBe(
      "https://smba.trafficmanager.net/teams/",
    );
  });

  it("is idempotent when the base url already ends in a slash", () => {
    expect(withTrailingSlash("https://smba.trafficmanager.net/teams/")).toBe(
      "https://smba.trafficmanager.net/teams/",
    );
  });
});

describe("resolveReplyToId", () => {
  it("forces a DM top-level (undefined) even when a replyTo is supplied", () => {
    const options: SendMessageOptions = {
      replyTo: "parent-activity-id",
      extra: { chatType: "dm" },
    };
    expect(resolveReplyToId(options, "thread-root")).toBeUndefined();
  });

  it("returns the explicit replyTo for a channel or group reply", () => {
    const options: SendMessageOptions = { replyTo: "parent-activity-id" };
    expect(resolveReplyToId(options)).toBe("parent-activity-id");
  });

  it("falls back to extra.replyToId when no top-level replyTo is set", () => {
    const options: SendMessageOptions = { extra: { replyToId: "from-extra" } };
    expect(resolveReplyToId(options)).toBe("from-extra");
  });

  it("threads under the fallback thread root when neither reply target is present", () => {
    expect(resolveReplyToId(undefined, "thread-root")).toBe("thread-root");
  });

  it("returns undefined when there is no reply target and no fallback thread", () => {
    expect(resolveReplyToId(undefined, undefined)).toBeUndefined();
  });
});

describe("resolveTypingServiceUrl", () => {
  it("reads a serviceUrl passed directly in the action params", () => {
    expect(resolveTypingServiceUrl({ serviceUrl: "https://direct/" })).toBe(
      "https://direct/",
    );
  });

  it("reads a serviceUrl nested under the extra params object", () => {
    expect(
      resolveTypingServiceUrl({ extra: { serviceUrl: "https://from-extra/" } }),
    ).toBe("https://from-extra/");
  });

  it("prefers the direct serviceUrl over the one nested under extra", () => {
    expect(
      resolveTypingServiceUrl({
        serviceUrl: "https://direct/",
        extra: { serviceUrl: "https://from-extra/" },
      }),
    ).toBe("https://direct/");
  });

  it("returns undefined when no serviceUrl is present at either location", () => {
    expect(resolveTypingServiceUrl({ chatId: "19:convo" })).toBeUndefined();
  });
});

const MENTIONABLE_BOT_ID = "28:6f2c8e1a-1b2c-3d4e-5f6a-7b8c9d0e1f2a";

describe("buildTextActivityBody", () => {
  it("returns the bare { type, text } shape with no entities/replyToId/attachments for plain text", () => {
    expect(buildTextActivityBody("plain text", undefined)).toEqual({
      type: "message",
      text: "plain text",
    });
  });

  it("rewrites id-shape-valid mention markup into <at> tags plus a mention entity", () => {
    const body = buildTextActivityBody(`hi @[Ada](${MENTIONABLE_BOT_ID})`, undefined) as {
      text: string;
      entities?: Array<{ type: string; mentioned: { id: string } }>;
    };
    expect(body.text).toContain("<at>Ada</at>");
    expect(body.entities?.[0]?.mentioned.id).toBe(MENTIONABLE_BOT_ID);
  });

  it("threads under replyToId when supplied", () => {
    const body = buildTextActivityBody("hi", "parent-activity-id");
    expect((body as { replyToId?: string }).replyToId).toBe("parent-activity-id");
  });

  it("attaches ONE Adaptive Card when buttons are present", () => {
    const options: SendMessageOptions = {
      buttons: [[{ text: "Approve", callback_data: "cb", style: "primary" }]],
    };
    const body = buildTextActivityBody("approval", undefined, options) as {
      attachments?: unknown[];
    };
    expect(body.attachments?.length).toBe(1);
  });
});

describe("buildAttachmentReferenceBody", () => {
  it("names the caption and filename in the by-reference text and threads under replyToId", () => {
    const attachment: AttachmentPayload = {
      type: "file",
      url: "/tmp/report.md",
      fileName: "report.md",
      caption: "Full report",
    };
    const body = buildAttachmentReferenceBody(attachment, "parent") as {
      text: string;
      replyToId?: string;
    };
    expect(body.text).toContain("Full report");
    expect(body.text).toContain("report.md");
    expect(body.text).not.toContain("data:");
    expect(body.replyToId).toBe("parent");
  });

  it("falls back to 'a file' and omits replyToId when no fileName/caption/thread is present", () => {
    const body = buildAttachmentReferenceBody({ type: "video", url: "/tmp/v.mp4" }, undefined) as {
      text: string;
      replyToId?: string;
    };
    expect(body.text).toContain("[a file]");
    expect(body.replyToId).toBeUndefined();
  });
});

describe("buildImageActivityBody", () => {
  it("inlines the bytes as a data: URI, carrying caption text + filename name, threaded under replyToId", () => {
    const attachment: AttachmentPayload = {
      type: "image",
      url: "/tmp/x.png",
      mimeType: "image/png",
      fileName: "x.png",
      caption: "look",
    };
    const body = buildImageActivityBody(Buffer.from("PNGBYTES"), attachment, "parent") as {
      text?: string;
      replyToId?: string;
      attachments: Array<{ contentType: string; contentUrl: string; name?: string }>;
    };
    expect(body.text).toBe("look");
    expect(body.replyToId).toBe("parent");
    expect(body.attachments[0]!.contentType).toBe("image/png");
    expect(body.attachments[0]!.contentUrl).toBe(
      `data:image/png;base64,${Buffer.from("PNGBYTES").toString("base64")}`,
    );
    expect(body.attachments[0]!.name).toBe("x.png");
  });

  it("defaults the contentType to image/png and omits text/name/replyToId when unspecified", () => {
    const body = buildImageActivityBody(Buffer.from("X"), { type: "image", url: "/tmp/x" }, undefined) as {
      text?: string;
      replyToId?: string;
      attachments: Array<{ contentType: string; name?: string }>;
    };
    expect(body.attachments[0]!.contentType).toBe("image/png");
    expect(body.text).toBeUndefined();
    expect(body.attachments[0]!.name).toBeUndefined();
    expect(body.replyToId).toBeUndefined();
  });
});
