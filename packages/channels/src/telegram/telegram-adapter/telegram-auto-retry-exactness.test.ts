// SPDX-License-Identifier: Apache-2.0
/** Wire-level delivery exactness for grammY's API transformer. */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { createTelegramAdapter } from "./index.js";

const BOT_TOKEN = "123456:test-token-exactness";

interface TelegramApiFixture {
  readonly apiRoot: string;
  readonly calls: () => number;
  readonly server: Server;
}

let activeServer: Server | undefined;

afterEach(async () => {
  if (!activeServer) return;
  activeServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    activeServer?.close((error) => error ? reject(error) : resolve());
  });
  activeServer = undefined;
});

async function startTelegramApi(
  respond: (
    call: number,
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<TelegramApiFixture> {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request body before simulating the Telegram response.
    }
    calls += 1;
    respond(calls, request, response);
  });
  activeServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Telegram test server has no port");
  }
  return {
    apiRoot: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    server,
  };
}

function successfulSend(response: import("node:http").ServerResponse): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    ok: true,
    result: {
      message_id: 77,
      date: 1,
      chat: { id: 1, type: "private" },
      text: "probe",
    },
  }));
}

function createAdapter(apiRoot: string) {
  return createTelegramAdapter({
    getBotToken: () => BOT_TOKEN,
    apiRoot,
    logger: createMockLogger(),
  });
}

describe("Telegram wire-level retry exactness", () => {
  it("does not retransmit a send after an ambiguous Telegram 500 response", async () => {
    const fixture = await startTelegramApi((call, _request, response) => {
      if (call === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ok: false,
          error_code: 500,
          description: "Internal Server Error",
        }));
        return;
      }
      successfulSend(response);
    });

    await expect(
      createAdapter(fixture.apiRoot).bot.api.sendMessage("1", "probe"),
    ).rejects.toThrow();
    expect(fixture.calls()).toBe(1);
  });

  it("does not retransmit a send after an ambiguous lost HTTP response", async () => {
    const fixture = await startTelegramApi((call, request, response) => {
      if (call === 1) {
        request.socket.destroy();
        return;
      }
      successfulSend(response);
    });

    await expect(
      createAdapter(fixture.apiRoot).bot.api.sendMessage("1", "probe"),
    ).rejects.toThrow();
    expect(fixture.calls()).toBe(1);
  });

  it("retries a definitive Telegram retry-after rejection", async () => {
    const fixture = await startTelegramApi((call, _request, response) => {
      response.setHeader("content-type", "application/json");
      if (call === 1) {
        response.end(JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 0 },
        }));
        return;
      }
      successfulSend(response);
    });

    await expect(
      createAdapter(fixture.apiRoot).bot.api.sendMessage("1", "probe"),
    ).resolves.toMatchObject({ message_id: 77 });
    expect(fixture.calls()).toBe(2);
  });
});
