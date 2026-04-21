// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for email MIME-to-NormalizedMessage mapper.
 *
 * Uses structural typing for the parsed mail input to avoid importing
 * the mailparser library in unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mapEmailToNormalized } from "./message-mapper.js";
import type { EmailParsedInput } from "./message-mapper.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("mapEmailToNormalized", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "email-mapper-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("maps text-only email to NormalizedMessage", async () => {
    const parsed: EmailParsedInput = {
      text: "Hello, world!",
      html: undefined,
      from: { value: [{ address: "sender@example.com", name: "Sender" }] },
      messageId: "<abc123@example.com>",
      subject: "Test Subject",
      inReplyTo: undefined,
      references: undefined,
      date: new Date("2026-01-01T00:00:00Z"),
      attachments: [],
    };

    const result = await mapEmailToNormalized(parsed, "email-channel-1", tmpDir);
    expect(result.text).toBe("Hello, world!");
    expect(result.chatType).toBe("dm");
    expect(result.channelType).toBe("email");
    expect(result.senderId).toBe("sender@example.com");
  });

  it("extracts text fallback from HTML when text body absent", async () => {
    const parsed: EmailParsedInput = {
      text: undefined,
      html: "<p>Hello <b>world</b></p>",
      from: { value: [{ address: "sender@example.com", name: "Sender" }] },
      messageId: "<html-msg@example.com>",
      subject: "HTML Only",
      inReplyTo: undefined,
      references: undefined,
      date: new Date("2026-01-01T00:00:00Z"),
      attachments: [],
    };

    const result = await mapEmailToNormalized(parsed, "email-channel-1", tmpDir);
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("world");
    // Should not contain HTML tags
    expect(result.text).not.toContain("<p>");
    expect(result.text).not.toContain("<b>");
  });

  it("extracts sender from From header as senderId", async () => {
    const parsed: EmailParsedInput = {
      text: "test",
      html: undefined,
      from: { value: [{ address: "person@domain.org", name: "Person" }] },
      messageId: "<msg1@domain.org>",
      subject: "Sender Test",
      inReplyTo: undefined,
      references: undefined,
      date: new Date(),
      attachments: [],
    };

    const result = await mapEmailToNormalized(parsed, "ch1", tmpDir);
    expect(result.senderId).toBe("person@domain.org");
  });

  it("sets metadata.emailMessageId from Message-ID header", async () => {
    const parsed: EmailParsedInput = {
      text: "test",
      html: undefined,
      from: { value: [{ address: "a@b.com", name: "" }] },
      messageId: "<unique-id-42@example.com>",
      subject: "ID Test",
      inReplyTo: undefined,
      references: undefined,
      date: new Date(),
      attachments: [],
    };

    const result = await mapEmailToNormalized(parsed, "ch1", tmpDir);
    expect(result.metadata.emailMessageId).toBe("<unique-id-42@example.com>");
  });

  it("sets metadata.emailSubject from Subject header", async () => {
    const parsed: EmailParsedInput = {
      text: "test",
      html: undefined,
      from: { value: [{ address: "a@b.com", name: "" }] },
      messageId: "<msg@b.com>",
      subject: "Important Subject",
      inReplyTo: undefined,
      references: undefined,
      date: new Date(),
      attachments: [],
    };

    const result = await mapEmailToNormalized(parsed, "ch1", tmpDir);
    expect(result.metadata.emailSubject).toBe("Important Subject");
  });

  it("maps image attachment to Attachment with type image and file:// URL", async () => {
    const parsed: EmailParsedInput = {
      text: "See attached",
      html: undefined,
      from: { value: [{ address: "a@b.com", name: "" }] },
      messageId: "<attach@b.com>",
      subject: "With Image",
      inReplyTo: undefined,
      references: undefined,
      date: new Date(),
      attachments: [
        {
          contentType: "image/png",
          filename: "photo.png",
          content: Buffer.from("fake-png-data"),
          size: 13,
        },
      ],
    };

    const result = await mapEmailToNormalized(parsed, "ch1", tmpDir);
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0].type).toBe("image");
    expect(result.attachments[0].url).toMatch(/^file:\/\//);
    expect(result.attachments[0].mimeType).toBe("image/png");
    expect(result.attachments[0].fileName).toBe("photo.png");
  });

  it("sets metadata.emailInReplyTo from In-Reply-To", async () => {
    const parsed: EmailParsedInput = {
      text: "reply",
      html: undefined,
      from: { value: [{ address: "a@b.com", name: "" }] },
      messageId: "<reply@b.com>",
      subject: "Re: Original",
      inReplyTo: "<original@b.com>",
      references: undefined,
      date: new Date(),
      attachments: [],
    };

    const result = await mapEmailToNormalized(parsed, "ch1", tmpDir);
    expect(result.metadata.emailInReplyTo).toBe("<original@b.com>");
  });
});
