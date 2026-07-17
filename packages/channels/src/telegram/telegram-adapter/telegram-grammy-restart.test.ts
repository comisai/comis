// SPDX-License-Identifier: Apache-2.0
/** Wire-level regression for grammY's in-memory polling offset across restarts. */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../credential-validator.js", async () => {
  const { ok } = await import("@comis/shared");
  return {
    validateBotToken: vi.fn(async () => ok({ id: 42, username: "test_bot", isBot: true })),
    validateWebhookSecret: vi.fn(),
  };
});

import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { createTelegramAdapter } from "./index.js";

const UPDATE_ID = 41;
const BOT_TOKEN = "123:test-token";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Telegram polling state");
}

async function startTelegramApi(offsets: number[]): Promise<string> {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = body.length > 0 ? JSON.parse(body) as Record<string, unknown> : {};
    const method = request.url?.split("/").at(-1);

    response.setHeader("content-type", "application/json");
    if (method === "getMe") {
      response.end(JSON.stringify({
        ok: true,
        result: { id: 42, is_bot: true, first_name: "Test", username: "test_bot" },
      }));
      return;
    }
    if (method === "deleteWebhook" || method === "setMyCommands") {
      response.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (method === "getUpdates") {
      const offset = typeof payload.offset === "number" ? payload.offset : 0;
      offsets.push(offset);
      if (offset <= UPDATE_ID) {
        response.end(JSON.stringify({
          ok: true,
          result: [{
            update_id: UPDATE_ID,
            message: {
              message_id: 7,
              date: 1_700_000_000,
              chat: { id: 99, type: "private", first_name: "User" },
              from: { id: 99, is_bot: false, first_name: "User" },
              text: "retry me",
            },
          }],
        }));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({
        ok: false,
        error_code: 401,
        description: "stop test polling",
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error_code: 404, description: "unsupported" }));
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Telegram test server has no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("Telegram grammY polling generation", () => {
  it("retries a failed update from its original offset with a fresh Bot", async () => {
    const offsets: number[] = [];
    const apiRoot = await startTelegramApi(offsets);
    const adapter = createTelegramAdapter({
      getBotToken: () => BOT_TOKEN,
      apiRoot,
      logger: createMockLogger(),
    });
    let attempts = 0;
    adapter.onMessage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("durable acceptance failed");
    });

    expect((await adapter.start()).ok).toBe(true);
    await waitUntil(() => attempts === 1 && adapter.getStatus?.().connected === false);
    expect((await adapter.start()).ok).toBe(true);
    await waitUntil(() => attempts === 2);

    expect(offsets.slice(0, 2)).toEqual([1, 1]);
  });
});
