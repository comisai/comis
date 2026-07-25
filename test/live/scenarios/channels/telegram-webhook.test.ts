// SPDX-License-Identifier: Apache-2.0
/** Telegram webhook fixture coverage and the product's fail-closed startup contract. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramPlugin, validateWebhookSecret } from "@comis/channels";
import { createMockLogger } from "../../../support/mock-logger.js";
import {
  createTgEmulator,
  type ChatRef,
  type TgEmulator,
} from "../../emulators/telegram/tg-emulator.js";
import { resetUpdateIdCounter } from "../../emulators/telegram/tg-payloads.js";
import {
  createWebhookReceiver,
  type WebhookReceiver,
} from "../../emulators/telegram/webhook-receiver.js";

const TEST_CHAT: ChatRef = { chatId: 424242 };
const FROM = { id: 777, firstName: "Webhooker", username: "webhooker" } as const;
const BOT_TOKEN = "12345:test";
const WEBHOOK_SECRET = "test-webhook-secret";

describe("Telegram webhook harness secret gate", () => {
  let receiver: WebhookReceiver;
  let emulator: TgEmulator;

  beforeEach(async () => {
    resetUpdateIdCounter();
    receiver = await createWebhookReceiver(WEBHOOK_SECRET);
    emulator = createTgEmulator({
      botToken: BOT_TOKEN,
      webhook: { url: receiver.url, secret: WEBHOOK_SECRET },
    });
    await emulator.start();
  });

  afterEach(async () => {
    await emulator.stop();
    await receiver.stop();
  });

  it("accepts the configured token and rejects wrong or absent tokens", async () => {
    expect(await emulator.postWebhookMessage(TEST_CHAT, FROM, "accepted")).toBe(200);
    expect(await emulator.postWebhookMessage(TEST_CHAT, FROM, "wrong", "wrong-token")).toBe(401);
    expect(await emulator.postWebhookMessage(TEST_CHAT, FROM, "absent", "")).toBe(401);

    expect(receiver.accepted()).toHaveLength(1);
    expect(receiver.rejectedCount()).toBe(2);
  });
});

describe("Telegram webhook product startup", () => {
  it("validates the bounded ASCII webhook secret format", () => {
    expect(validateWebhookSecret("").ok).toBe(false);
    expect(validateWebhookSecret("a".repeat(257)).ok).toBe(false);
    expect(validateWebhookSecret("non-ascii-é").ok).toBe(false);
    expect(validateWebhookSecret(WEBHOOK_SECRET).ok).toBe(true);
  });

  it("rejects webhook configuration before validation or polling can start", async () => {
    let tokenReads = 0;
    const plugin = createTelegramPlugin({
      getBotToken: () => {
        tokenReads += 1;
        return BOT_TOKEN;
      },
      webhookUrl: "https://example.com/telegram",
      webhookSecret: WEBHOOK_SECRET,
      logger: createMockLogger(),
    });
    // Adapter construction resolves the token for its inert initial Bot. The
    // rejected start must not resolve it again or make a Bot API request.
    expect(tokenReads).toBe(1);

    const result = await plugin.activate();

    expect(result.ok).toBe(false);
    expect(tokenReads).toBe(1);
    expect(plugin.adapter.getStatus?.().connected).toBe(false);
  });
});
