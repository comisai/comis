// SPDX-License-Identifier: Apache-2.0
/**
 * The HARNESS-SIDE webhook secret-token gate (AUTO-05, Phase 208).
 *
 * The Telegram webhook contract: when a bot is registered with a `secret_token`,
 * Telegram stamps every delivered Update with the
 * `X-Telegram-Bot-Api-Secret-Token` header, and the host's ingestion route is
 * expected to REJECT any POST whose header is wrong or absent (a forged Update
 * without the shared secret is untrusted). See the grammy `webhookCallback({
 * secretToken })` primitive and Telegram's setWebhook docs.
 *
 * ⚠ THE PRODUCT GAP (AUTO-05 finding, re-verified at HEAD this session): Comis
 * has NO Telegram webhook ingestion route. `shouldUseRunner` (telegram-webhook.ts:116)
 * returns `!webhookUrl` and merely SKIPS the polling runner when a `webhookUrl`
 * is configured, with NOTHING replacing it — `bot.handleUpdate` is driven by no
 * Comis code and no route checks `X-Telegram-Bot-Api-Secret-Token`
 * (`grep -rn webhookCallback packages/` → 0; the only reference is a comment,
 * "the host process is expected to drive bot.handleUpdate externally"). So
 * end-to-end webhook ingestion (a POSTed Update reaching the agent) is a REAL
 * product boundary, NOT something this harness can drive into the agent.
 *
 * What this receiver IS: the harness-side proof of AUTO-05's secret-token gate.
 * It stands up a tiny loopback HTTP server that enforces EXACTLY the discipline
 * a real ingestion route must — a POST with the configured token is accepted
 * (200) and the Update is recorded; a POST with a WRONG or ABSENT token is
 * rejected (401) and NOT recorded. The {@link TgEmulator.postWebhookMessage}
 * webhook-POST mode drives it. This proves the harness can POST a grammy Update
 * carrying the secret-token header AND that the gate rejects a forged one —
 * WITHOUT asserting the (non-existent) product ingestion path.
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change. `test/` is outside the packages ESLint/architecture
 * rules, so a raw `node:http` loopback server + `Date.now` are fine here. This
 * receiver is INTENTIONALLY a standalone loopback target (the webhook URL is a
 * different endpoint from the Bot API the emulator serves), so it does NOT
 * compose the http-backend base — it is a test fixture, not the emulator.
 *
 * @module
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Update } from "grammy/types";
import {
  TELEGRAM_WEBHOOK_SECRET_TOKEN_HEADER,
  checkWebhookSecretToken,
} from "./tg-emulator.js";

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
