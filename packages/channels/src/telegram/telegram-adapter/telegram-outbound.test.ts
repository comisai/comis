// SPDX-License-Identifier: Apache-2.0
/**
 * sendAttachment — media-send observability.
 *
 * A successful Telegram send ALWAYS returns a numeric message_id. When the
 * platform returns no id (a non-standard/empty envelope or a dropped upload),
 * the adapter must not log "attachment sent" with messageId:"undefined" and
 * return ok(String(undefined)) === "undefined" — a SILENT false success that
 * hides a real delivery failure (generated media can look delivered while the
 * channel never received it, diagnosable only by a multi-hop daemon-log
 * hand-join).
 */
import { describe, it, expect, vi } from "vitest";
import { sendAttachment } from "./telegram-outbound.js";
import type {
  TelegramAdapterDeps,
  TelegramAdapterState,
} from "./telegram-adapter-types.js";
import type { AttachmentPayload } from "@comis/core";

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function makeState(sendResult: unknown): TelegramAdapterState {
  const send = vi.fn().mockResolvedValue(sendResult);
  return {
    bot: { api: { sendPhoto: send, sendAudio: send, sendVideo: send, sendDocument: send } },
  } as unknown as TelegramAdapterState;
}

const IMG: AttachmentPayload = {
  type: "image",
  url: "/tmp/generated.png",
  fileName: "generated.png",
} as AttachmentPayload;

const PRIVATE_CAPTION = "PRIVATE-CAPTION-DO-NOT-LOG";
const PRIVATE_FILE_NAME = "PRIVATE-FILENAME-DO-NOT-LOG.xlsx";

describe("sendAttachment — media-send message_id guard", () => {
  it("WARNs + returns err when the platform returns no message_id (no silent ok('undefined'))", async () => {
    const state = makeState({}); // <- no message_id (the emulator/unsupported-method shape)
    const logger = makeLogger();
    const deps = { logger } as unknown as TelegramAdapterDeps;

    const res = await sendAttachment(state, deps, "678314278", IMG);

    expect(res.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "platform", attachmentType: "image" }),
      expect.stringContaining("no message_id"),
    );
    // The false-success info line must NOT fire when the send was not accepted.
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Local file attachment sent",
    );
  });

  it("returns ok(message_id) on a normal accepted send", async () => {
    const state = makeState({ message_id: 4242 });
    const logger = makeLogger();
    const deps = { logger } as unknown as TelegramAdapterDeps;

    const res = await sendAttachment(state, deps, "678314278", IMG);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe("4242");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never logs attachment caption or filename content on accepted or rejected sends", async () => {
    const attachment = {
      type: "file",
      url: "/tmp/private-report.xlsx",
      fileName: PRIVATE_FILE_NAME,
      caption: PRIVATE_CAPTION,
    } as AttachmentPayload;
    const acceptedLogger = makeLogger();
    const rejectedLogger = makeLogger();

    await sendAttachment(
      makeState({ message_id: 4242 }),
      { logger: acceptedLogger } as unknown as TelegramAdapterDeps,
      "678314278",
      attachment,
    );
    await sendAttachment(
      makeState({}),
      { logger: rejectedLogger } as unknown as TelegramAdapterDeps,
      "678314278",
      attachment,
    );

    const serializedLogs = JSON.stringify([
      ...acceptedLogger.debug.mock.calls,
      ...acceptedLogger.info.mock.calls,
      ...acceptedLogger.warn.mock.calls,
      ...acceptedLogger.error.mock.calls,
      ...rejectedLogger.debug.mock.calls,
      ...rejectedLogger.info.mock.calls,
      ...rejectedLogger.warn.mock.calls,
      ...rejectedLogger.error.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(PRIVATE_CAPTION);
    expect(serializedLogs).not.toContain(PRIVATE_FILE_NAME);
    expect(acceptedLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentType: "file",
        captionLength: PRIVATE_CAPTION.length,
        hasFileName: true,
      }),
      "Outbound attachment",
    );
  });
});
