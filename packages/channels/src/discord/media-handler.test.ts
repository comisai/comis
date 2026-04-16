import { describe, expect, it } from "vitest";
import { buildDiscordAttachments } from "./media-handler.js";

/** Helper to create a minimal Discord Message stub. */
function stubMessage(overrides: Record<string, unknown> = {}): any {
  return {
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

/** Helper to create a Discord attachment-like object. */
function makeAttachment(
  id: string,
  opts: {
    url?: string;
    contentType?: string | null;
    name?: string;
    size?: number;
  } = {},
) {
  return [
    id,
    {
      url: opts.url ?? `https://cdn.discordapp.com/attachments/123/${id}/file`,
      contentType: opts.contentType ?? null,
      name: opts.name ?? null,
      size: opts.size ?? null,
    },
  ] as const;
}

describe("media-handler / buildDiscordAttachments", () => {
  it("returns empty array when no attachments or stickers are present", () => {
    const msg = stubMessage();
    expect(buildDiscordAttachments(msg)).toEqual([]);
  });

  it("image attachment (contentType 'image/png') maps to type 'image'", () => {
    const msg = stubMessage({
      attachments: new Map([
        makeAttachment("img1", {
          contentType: "image/png",
          name: "screenshot.png",
          size: 204800,
        }),
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("image");
    expect(result[0].mimeType).toBe("image/png");
  });

  it("audio attachment maps to type 'audio'", () => {
    const msg = stubMessage({
      attachments: new Map([
        makeAttachment("aud1", {
          contentType: "audio/mpeg",
          name: "recording.mp3",
        }),
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("audio");
    expect(result[0].mimeType).toBe("audio/mpeg");
  });

  it("video attachment maps to type 'video'", () => {
    const msg = stubMessage({
      attachments: new Map([
        makeAttachment("vid1", {
          contentType: "video/mp4",
          name: "clip.mp4",
        }),
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("video");
    expect(result[0].mimeType).toBe("video/mp4");
  });

  it("unknown contentType maps to type 'file'", () => {
    const msg = stubMessage({
      attachments: new Map([
        makeAttachment("doc1", {
          contentType: "application/pdf",
          name: "report.pdf",
        }),
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("file");
  });

  it("null contentType maps to type 'file'", () => {
    const msg = stubMessage({
      attachments: new Map([makeAttachment("unknown1", { contentType: null })]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("file");
  });

  it("multiple attachments are all extracted", () => {
    const msg = stubMessage({
      attachments: new Map([
        makeAttachment("img1", { contentType: "image/jpeg", name: "photo.jpg" }),
        makeAttachment("vid1", { contentType: "video/mp4", name: "clip.mp4" }),
        makeAttachment("doc1", { contentType: "application/zip", name: "archive.zip" }),
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("image");
    expect(result[1].type).toBe("video");
    expect(result[2].type).toBe("file");
  });

  it("attachment url, fileName, sizeBytes, mimeType are correctly mapped", () => {
    const msg = stubMessage({
      attachments: new Map([
        makeAttachment("file1", {
          url: "https://cdn.discordapp.com/attachments/123/file1/report.pdf",
          contentType: "application/pdf",
          name: "report.pdf",
          size: 1048576,
        }),
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "file",
      url: "https://cdn.discordapp.com/attachments/123/file1/report.pdf",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      sizeBytes: 1048576,
    });
  });

  it("stickers are converted to image attachments", () => {
    const msg = stubMessage({
      stickers: new Map([
        [
          "sticker1",
          {
            url: "https://cdn.discordapp.com/stickers/sticker1.png",
            name: "cool_sticker",
          },
        ],
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("image");
    expect(result[0].url).toBe("https://cdn.discordapp.com/stickers/sticker1.png");
    expect(result[0].fileName).toBe("cool_sticker");
  });

  it("handles message with both attachments and stickers", () => {
    const msg = stubMessage({
      attachments: new Map([
        makeAttachment("img1", { contentType: "image/png", name: "photo.png" }),
      ]),
      stickers: new Map([
        [
          "sticker1",
          {
            url: "https://cdn.discordapp.com/stickers/sticker1.png",
            name: "sticker",
          },
        ],
      ]),
    });

    const result = buildDiscordAttachments(msg);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("image"); // attachment
    expect(result[1].type).toBe("image"); // sticker
  });
});
