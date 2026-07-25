// SPDX-License-Identifier: Apache-2.0
/**
 * Loopback-only Telegram webhook fixture.
 *
 * It accepts updates carrying the configured secret-token header and rejects
 * wrong or absent tokens. Comis currently rejects Telegram webhook
 * configuration, so this fixture tests emulator behavior only and does not
 * represent a product ingestion route.
 *
 * @module
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Update } from "grammy/types";
import { checkWebhookSecretToken } from "./tg-emulator.js";

/** A handle for a running {@link createWebhookReceiver} loopback target. */
export interface WebhookReceiver {
  /** The loopback URL the emulator's webhook-POST mode targets (`http://127.0.0.1:<port>`). */
  readonly url: string;
  /** Every Update ACCEPTED (correct token) by the gate, in arrival order — the gate's "delivered" oracle. */
  accepted(): readonly Update[];
  /** The count of POSTs REJECTED (wrong/absent token) by the gate — the gate's "blocked" oracle. */
  rejectedCount(): number;
  /** Stop the loopback server (idempotent). */
  stop(): Promise<void>;
}

/**
 * Stand up the harness-side webhook receiver enforcing the secret-token gate.
 *
 * Binds 127.0.0.1 on an ephemeral port (loopback only — never a wildcard host).
 * On each POST it reads the `X-Telegram-Bot-Api-Secret-Token` header and routes
 * through {@link checkWebhookSecretToken} against `expectedSecret`:
 *   - token MATCHES   → 200, parse the JSON body as an `Update`, record it.
 *   - token WRONG/ABSENT → 401, record nothing (the gate's reject).
 *
 * @param expectedSecret the configured secret token the gate requires.
 */
export async function createWebhookReceiver(expectedSecret: string): Promise<WebhookReceiver> {
  const accepted: Update[] = [];
  let rejected = 0;

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const presented = req.headers["x-telegram-bot-api-secret-token"];
    const presentedValue = Array.isArray(presented) ? presented[0] : presented;
    // The harness-side secret-token gate: accept ONLY the configured token.
    if (!checkWebhookSecretToken(expectedSecret, presentedValue)) {
      rejected += 1;
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error_code: 401, description: "unauthorized: bad secret token" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
    });
    req.on("end", () => {
      try {
        const update = JSON.parse(raw) as Update;
        accepted.push(update);
      } catch {
        // A malformed body on an authorized POST is still a delivered-but-bad
        // request; record nothing and 400 (the gate already passed — this is a
        // shape error, not an auth error).
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error_code: 400, description: "bad update body" }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    accepted() {
      return [...accepted];
    },
    rejectedCount() {
      return rejected;
    },
    stop() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
