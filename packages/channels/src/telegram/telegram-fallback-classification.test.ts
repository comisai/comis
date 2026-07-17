// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import type { TelegramAdapterDeps, TelegramAdapterState } from "./telegram-adapter/telegram-adapter-types.js";
import { sendMessage } from "./telegram-adapter/telegram-outbound.js";
import {
  isTelegramHtmlParseError,
  sendWithThreadFallback,
} from "./telegram-adapter/telegram-webhook.js";
import { isTelegramThreadNotFoundError } from "./thread-context.js";
import { createTelegramVoiceSender } from "./voice-sender.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

function makeGrammyError(
  description: string,
  errorCode = 400,
  method = "sendMessage",
): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: errorCode, description },
    method,
    {},
  );
}

function makeOutbound(sendMessageMock: ReturnType<typeof vi.fn>): {
  state: TelegramAdapterState;
  deps: TelegramAdapterDeps;
} {
  const logger = createMockLogger();
  return {
    state: {
      connected: true,
      bot: { api: { sendMessage: sendMessageMock } },
    } as unknown as TelegramAdapterState,
    deps: { logger } as unknown as TelegramAdapterDeps,
  };
}

describe("Telegram fallback error authenticity", () => {
  it("rejects plain errors and strings that imitate Telegram HTML failures", () => {
    const description = "Bad Request: can't parse entities: Unsupported start tag";

    expect(isTelegramHtmlParseError(new Error(description))).toBe(false);
    expect(isTelegramHtmlParseError(description)).toBe(false);
  });

  it("accepts only Telegram 400 HTML parse descriptions, including a trusted cause", () => {
    const parseError = makeGrammyError(
      "Bad Request: can't parse entities: Unsupported start tag at byte offset 8",
    );
    const endError = makeGrammyError(
      "Bad Request: can't find end of the entity starting at byte offset 8",
    );

    expect(isTelegramHtmlParseError(parseError)).toBe(true);
    expect(isTelegramHtmlParseError(new Error("Outbound wrapper", { cause: endError }))).toBe(true);
    expect(isTelegramHtmlParseError(makeGrammyError(parseError.description, 500))).toBe(false);
    expect(isTelegramHtmlParseError(makeGrammyError("Bad Request: entity parsing failed"))).toBe(false);
  });

  it("performs one plain-text fallback after a definitive Telegram HTML rejection", async () => {
    const apiSend = vi.fn()
      .mockRejectedValueOnce(makeGrammyError(
        "Bad Request: can't parse entities: Unsupported start tag at byte offset 8",
      ))
      .mockResolvedValueOnce({ message_id: 22 });
    const { state, deps } = makeOutbound(apiSend);

    const result = await sendMessage(state, deps, "123", "<bad>text");

    expect(result).toEqual({ ok: true, value: "22" });
    expect(apiSend).toHaveBeenCalledTimes(2);
    expect(apiSend.mock.calls[0]?.[2]).toEqual({ parse_mode: "HTML" });
    expect(apiSend.mock.calls[1]?.[2]).toEqual({});
  });

  it("never retries HTML delivery after a matching plain or non-400 error", async () => {
    for (const error of [
      new Error("Bad Request: can't parse entities: Unsupported start tag"),
      "Bad Request: can't parse entities: Unsupported start tag",
      makeGrammyError("Bad Request: can't parse entities: Unsupported start tag", 500),
    ]) {
      const apiSend = vi.fn().mockRejectedValue(error);
      const { state, deps } = makeOutbound(apiSend);

      const result = await sendMessage(state, deps, "123", "<bad>text");

      expect(result.ok).toBe(false);
      expect(apiSend).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts only exact Telegram 400 thread-terminal descriptions", () => {
    expect(isTelegramThreadNotFoundError(
      makeGrammyError("Bad Request: message thread not found"),
    )).toBe(true);
    expect(isTelegramThreadNotFoundError(
      makeGrammyError("Bad Request: TOPIC_CLOSED"),
    )).toBe(true);
    expect(isTelegramThreadNotFoundError(
      new Error("Outbound wrapper", {
        cause: makeGrammyError("Bad Request: TOPIC_DELETED"),
      }),
    )).toBe(true);
    expect(isTelegramThreadNotFoundError(
      makeGrammyError("Bad Request: message thread not found", 500),
    )).toBe(false);
    expect(isTelegramThreadNotFoundError(
      makeGrammyError("Bad Request: unrelated message thread not found"),
    )).toBe(false);
    expect(isTelegramThreadNotFoundError(
      new Error("Bad Request: message thread not found"),
    )).toBe(false);
    expect(isTelegramThreadNotFoundError("Bad Request: TOPIC_CLOSED")).toBe(false);
  });

  it("removes thread context once after a definitive Telegram thread rejection", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(makeGrammyError("Bad Request: message thread not found"))
      .mockResolvedValueOnce("accepted");

    const result = await sendWithThreadFallback(
      send,
      { message_thread_id: 42 },
      createMockLogger(),
    );

    expect(result).toBe("accepted");
    expect(send.mock.calls).toEqual([
      [{ message_thread_id: 42 }],
      [undefined],
    ]);
  });

  it("never removes thread context for matching plain or non-400 errors", async () => {
    for (const error of [
      new Error("Bad Request: message thread not found"),
      "Bad Request: TOPIC_CLOSED",
      makeGrammyError("Bad Request: TOPIC_DELETED", 500),
    ]) {
      const send = vi.fn().mockRejectedValue(error);

      await expect(sendWithThreadFallback(
        send,
        { message_thread_id: 42 },
        createMockLogger(),
      )).rejects.toBe(error);
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({ message_thread_id: 42 });
    }
  });

  it("changes voice delivery to a document only for exact Telegram 400 denials", async () => {
    const logger = createMockLogger();
    const sendVoice = vi.fn().mockRejectedValue(
      makeGrammyError("Bad Request: VOICE_MESSAGES_FORBIDDEN", 400, "sendVoice"),
    );
    const sendDocument = vi.fn().mockResolvedValue({ message_id: 45 });
    const sender = createTelegramVoiceSender({
      bot: { api: { sendVoice, sendDocument } } as never,
      logger,
    });

    const result = await sender.sendVoice("123", "/tmp/voice.ogg", 2);

    expect(result).toEqual({ ok: true, value: { kind: "tracked", messageId: "45" } });
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendDocument).toHaveBeenCalledTimes(1);
  });

  it("never changes voice delivery for matching plain or non-400 errors", async () => {
    for (const error of [
      new Error("Bad Request: VOICE_MESSAGES_FORBIDDEN"),
      "Bad Request: CHAT_SEND_VOICES_FORBIDDEN",
      makeGrammyError("Bad Request: VOICE_MESSAGES_FORBIDDEN", 403, "sendVoice"),
    ]) {
      const sendVoice = vi.fn().mockRejectedValue(error);
      const sendDocument = vi.fn();
      const sender = createTelegramVoiceSender({
        bot: { api: { sendVoice, sendDocument } } as never,
        logger: createMockLogger(),
      });

      const result = await sender.sendVoice("123", "/tmp/voice.ogg", 2);

      expect(result.ok).toBe(false);
      expect(sendVoice).toHaveBeenCalledTimes(1);
      expect(sendDocument).not.toHaveBeenCalled();
    }
  });
});
