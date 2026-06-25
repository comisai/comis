// SPDX-License-Identifier: Apache-2.0
/**
 * sendAttachment — media-send observability (OBS-1).
 *
 * A successful Telegram send ALWAYS returns a numeric message_id. When the
 * platform returns no id (a non-standard/empty envelope or a dropped upload),
 * the adapter used to log "attachment sent" with messageId:"undefined" and
 * return ok(String(undefined)) === "undefined" — a SILENT false success that
 * hid a real delivery failure (openclaw-usecases 2026-06-25: image-gen + TTS
 * produced real artifacts but were never delivered; the channel oracle showed
 * 0 media sends, diagnosable only by a 4-hop daemon-log hand-join).
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

describe("sendAttachment — media-send id guard (OBS-1)", () => {
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
});
