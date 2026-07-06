// SPDX-License-Identifier: Apache-2.0
/**
 * `GoogleChatEmulator` — the fake Google the REAL production Google Chat adapter
 * talks to over loopback HTTP. Built ON the generalized `http-backend` base and
 * `extends ChannelEmulator`.
 *
 * GOOGLE CHAT IS A PULL CHANNEL (like Telegram/Signal, unlike Teams' push): the
 * adapter connects OUT to three fake surfaces the emulator serves on ONE loopback
 * port, redirected via the adapter's shipped base-URL DI seams
 * (`tokenUrl`/`pubsubBaseUrl`/`chatBaseUrl`) — so NO host-rewrite fetch is needed
 * (unlike Teams' `connectorRedirectFetch`):
 *
 *   - TOKEN: `POST {tokenUrl}` — the service-account JWT-bearer exchange. The
 *     emulator IS Google here, so it never verifies the assertion; it returns an
 *     opaque `{ access_token, expires_in }` and counts the mint. Both the chat.bot
 *     and pubsub scopes hit the same endpoint.
 *   - PUB/SUB (inbound): `POST {pubsubBaseUrl}/{sub}:pull` (long-poll) serves the
 *     queued inbound events as base64 `receivedMessages[].message.data`, and
 *     `POST {pubsubBaseUrl}/{sub}:acknowledge` removes the acked ones. A queued
 *     event stays until it is acked (the real ack contract) — the pull is
 *     non-destructive, so a skip-ack redelivers.
 *   - CHAT REST (outbound): `POST {chatBaseUrl}/spaces/{space}/messages` (create),
 *     `PATCH …/messages/{id}` (edit), `DELETE …/messages/{id}` — each recorded to
 *     the per-space outbound oracle (the dual-oracle read).
 *
 * The routes match on path SHAPE (a `:pull`/`:acknowledge` suffix, a `/token`
 * suffix, a `/spaces/…/messages` segment), so ONE emulator serves the adapter
 * whether the base URLs are the bare loopback origin (the in-process scenario) or
 * carry the `/chat/v1` · `/pubsub/v1` · `/token` leg prefixes the daemon egress
 * seam collapses onto one host (the full-daemon self-drive).
 *
 * Webhook mode is not exercised by the pull-driven scenario, but the emulator also
 * holds an RS256 keypair and mints inbound Chat-event Bearers ({@link signInboundToken})
 * the adapter's OWN local-JWKS verifier accepts, so the webhook leg can round-trip
 * offline via {@link publicJwks} / {@link writeJwksFile}.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production runtime
 * change. `@comis/*` is imported `type`-only elsewhere in the harness; this file
 * imports none.
 *
 * @module
 */

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SignJWT } from "jose";
import {
  createHttpBackend,
  type HttpBackend,
  type RouteContext,
  type RouteResult,
} from "../../harness/backends/http-backend.js";
import type { ChannelCaps, ChannelEmulator } from "../../harness/channel-emulator.js";
import type { RecordedOutbound } from "../../harness/recorded-outbound.js";
import { googlechatCaps } from "./googlechat-caps.js";

/**
 * The issuer of a project-number-audience Chat event token — Google's Chat system
 * service account. The adapter's `project-number` verifier defaults its expected
 * issuer to this, so the emulator signs inbound tokens with it. A real code
 * contract token (not build pre-history).
 */
const CHAT_SYSTEM_ISSUER = "chat@system.gserviceaccount.com";
/** The signing key id, stamped on both the JWK and every minted inbound token header. */
const EMULATOR_KID = "googlechat-emulator-key-1";
/** The default Cloud project number the emulator signs inbound tokens for (the token `aud`). */
const DEFAULT_PROJECT_NUMBER = "000000000001";
/** The default service-account client email stamped on the fake SA key JSON. */
const DEFAULT_CLIENT_EMAIL = "comis-emulator@test-project.iam.gserviceaccount.com";
/** How many messages a single `:pull` serves at most (mirrors the loop's maxMessages). */
const PULL_MAX_MESSAGES = 10;
/** Long-poll window on an empty `:pull` before returning empty (bounds the loop's re-poll). */
const PULL_LONG_POLL_MS = 2_000;
/** Poll interval inside the long-poll wait. */
const PULL_POLL_INTERVAL_MS = 15;

/**
 * A recorded outbound Chat REST mutation (the Google Chat superset of the shared
 * {@link RecordedOutbound} — assignable to it, so the control-api + dual-oracle
 * read the `{ method, messageId, text }` subset unchanged).
 */
export interface GoogleChatRecordedOutbound extends RecordedOutbound {
  /** The Chat operation: create (send) / edit / delete. */
  readonly op: "send" | "edit" | "delete";
  /** The space resource name the mutation targeted ("spaces/AAAA"). */
  readonly space: string;
  /** The message resource name (minted on create, the target on edit/delete). */
  readonly messageName?: string;
  /** True when the body carried a `cardsV2` array (a Cards v2 render). */
  readonly hasCards?: boolean;
  /** The thread resource name a threaded reply set (`body.thread.name`), when present. */
  readonly threadName?: string;
}

/** Options for {@link createGoogleChatEmulator}. */
export interface CreateGoogleChatEmulatorOptions {
  /** The Cloud project number the emulator signs inbound tokens for. Defaults to {@link DEFAULT_PROJECT_NUMBER}. */
  readonly projectNumber?: string;
  /** The service-account client email on the fake SA key. Defaults to {@link DEFAULT_CLIENT_EMAIL}. */
  readonly clientEmail?: string;
}

/**
 * `GoogleChatEmulator` — `ChannelEmulator` + the Google-specific outbound oracle,
 * the Pub/Sub inbound queue, the fake SA key, and the inbound-token signer.
 * `start()`/`stop()` delegate to the http-backend base.
 *
 * A Google Chat "chat" is the space resource name ("spaces/AAAA"); the per-space
 * oracle keys on it (matching the adapter's `msg.channelId`).
 */
export interface GoogleChatEmulator extends ChannelEmulator {
  /**
   * The SHARED loopback http-backend base this emulator composes. Exposed so the
   * rig / control API can register additional routes on the SAME loopback port.
   * The emulator owns the base's lifecycle — `start()`/`stop()` delegate to it.
   */
  readonly backend: HttpBackend;
  /** The configured Cloud project number (the inbound token `aud`). */
  readonly projectNumber: string;
  /**
   * A parseable service-account key JSON (`client_email` + an unencrypted PKCS#8
   * `private_key`) the adapter's token provider imports and signs with. The token
   * endpoint never verifies the resulting assertion — this key only needs to be a
   * valid RS256 signing key jose can import.
   */
  fakeServiceAccountKeyJson(): string;
  /**
   * The public JWKS the adapter's local-JWKS inbound verifier verifies against (a
   * single RS256 signing key). Feed it to `createLocalGoogleChatInboundVerifier`
   * in an in-process scenario, or persist it with {@link writeJwksFile} for the
   * daemon's `COMIS_GOOGLECHAT_TEST_JWKS` seam.
   */
  publicJwks(): { keys: JsonWebKey[] };
  /** Persist {@link publicJwks} to `filePath` (the daemon `COMIS_GOOGLECHAT_TEST_JWKS` seam reads it). */
  writeJwksFile(filePath: string): void;
  /**
   * Mint a signed inbound Chat-event Bearer (`iss=chat@system.gserviceaccount.com`,
   * `aud=projectNumber`, RS256, 5-min expiry) the adapter's local-JWKS verifier
   * accepts. Override `audience` to exercise the wrong-audience reject path, or
   * `issuer` for a fully-synthetic issuer.
   */
  signInboundToken(opts?: { audience?: string; issuer?: string }): Promise<string>;
  /** Enqueue an inbound event onto the fake Pub/Sub subscription (the pull queue). */
  injectInbound(event: unknown): void;
  /** The full recorded outbound Chat log for a space, in order (the oracle). `[]` for an unseen space. */
  outbound(space: string): readonly GoogleChatRecordedOutbound[];
  /** The most recent recorded outbound for a space, or `undefined` (the dual-oracle read). */
  lastBotReply(space: string): GoogleChatRecordedOutbound | undefined;
  /** Clear a space's recorded outbound (per-test isolation). */
  resetChat(space: string): void;
  /** How many times the fake token endpoint was hit (proves the SA-token mint ran). */
  tokenMintCount(): number;
  /** How many Pub/Sub messages have been acknowledged (proves the ack contract). */
  ackedCount(): number;
  /** How many inbound events are still queued (un-acked). */
  pendingCount(): number;
}

/** Parse a raw JSON body defensively (a malformed body → empty object). */
function parseJson(body: string): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Match a Chat REST message path and pull out the space + optional message-id
 * segment, tolerating an optional leg prefix (`/chat/v1`). Group 1 = the space
 * resource name ("spaces/AAAA"); group 2 = the message-id segment on edit/delete.
 */
const CHAT_MESSAGE_RE = /\/(spaces\/[^/]+)\/messages(?:\/([^/]+))?$/;

/** One queued Pub/Sub message (a base64 envelope + its ack id + the dedup name). */
interface QueuedMessage {
  ackId: string;
  messageId: string;
  data: string;
}

/**
 * Create the Google Chat wire emulator on the shared http-backend base.
 *
 * Composes `createHttpBackend()`, registers the token + Pub/Sub + Chat REST
 * surfaces on the base's generalized path routes, and returns an object literal
 * whose `caps`/`start`/`stop` delegate to the base plus the per-space outbound
 * oracle, the inbound queue, and the inbound-token signer. The RS256 keypair is
 * generated SYNCHRONOUSLY at construction (node:crypto), so the factory stays sync
 * like the Telegram/Signal/Teams factories.
 */
export function createGoogleChatEmulator(
  opts: CreateGoogleChatEmulatorOptions = {},
): GoogleChatEmulator {
  const backend: HttpBackend = createHttpBackend();
  const projectNumber = opts.projectNumber ?? DEFAULT_PROJECT_NUMBER;
  const clientEmail = opts.clientEmail ?? DEFAULT_CLIENT_EMAIL;

  // ONE RSA keypair, generated synchronously (2048-bit, the RS256 the adapter
  // pins). It serves BOTH roles the emulator needs — the private half is exported
  // as the fake SA key's PKCS#8 PEM (the adapter's outbound token mint imports it)
  // and is used to sign inbound webhook Bearers; the public half is the JWKS the
  // adapter's local-JWKS inbound verifier verifies against. The two roles are
  // never cross-checked (the token endpoint is opaque), so sharing one keypair is
  // a harmless test simplification that halves keygen cost.
  const { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject } =
    generateKeyPairSync("rsa", { modulusLength: 2048 });
  const saPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const signingJwk: JsonWebKey = { ...publicJwk, kid: EMULATOR_KID, alg: "RS256", use: "sig" };

  // Per-space ORACLE state (the outbound Chat REST mutation log), keyed on the
  // space resource name (the adapter's msg.channelId).
  const spaces = new Map<string, GoogleChatRecordedOutbound[]>();
  // The Pub/Sub inbound queue — messages stay until acked (the ack contract).
  const queue: QueuedMessage[] = [];
  // Strictly-monotonic sources: outbound message ids, ackIds, and mint/ack counts.
  let outboundSeq = 5_000;
  let ackSeq = 0;
  let mintCount = 0;
  let ackedTotal = 0;
  let stopped = false;

  function spaceLog(space: string): GoogleChatRecordedOutbound[] {
    let log = spaces.get(space);
    if (log === undefined) {
      log = [];
      spaces.set(space, log);
    }
    return log;
  }

  function record(ro: GoogleChatRecordedOutbound): void {
    spaceLog(ro.space).push(ro);
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // --- Fake token endpoint (the service-account JWT-bearer exchange) ---
  // POST {tokenUrl} → an opaque access token. The emulator IS Google, so it never
  // validates the assertion — but the adapter must obtain a token before it POSTs,
  // so this answers 200 with a token + expiry. Both scopes hit the same endpoint.
  backend.registerPathRoute(
    (path) => path.endsWith("/token"),
    (): RouteResult => {
      mintCount += 1;
      return {
        status: 200,
        body: { access_token: "emulator-access-token", expires_in: 3600 },
      };
    },
  );

  // --- Fake Pub/Sub :pull (long-poll, non-destructive) ---
  backend.registerPathRoute(
    (path) => path.endsWith(":pull"),
    async (): Promise<RouteResult> => {
      const startedAt = Date.now();
      // Bounded long-poll: mirror the real subscription pull so the adapter's
      // self-rescheduling loop parks here instead of hammering the loopback base
      // on an empty subscription. The `stopped` flag bails immediately on stop().
      while (
        !stopped &&
        queue.length === 0 &&
        Date.now() - startedAt < PULL_LONG_POLL_MS
      ) {
        await sleep(PULL_POLL_INTERVAL_MS);
      }
      const batch = queue.slice(0, PULL_MAX_MESSAGES);
      return {
        status: 200,
        body: {
          receivedMessages: batch.map((m) => ({
            ackId: m.ackId,
            message: { data: m.data, messageId: m.messageId },
          })),
        },
      };
    },
  );

  // --- Fake Pub/Sub :acknowledge (removes acked messages) ---
  backend.registerPathRoute(
    (path) => path.endsWith(":acknowledge"),
    (ctx: RouteContext): RouteResult => {
      const body = parseJson(ctx.body);
      const ackIds = Array.isArray(body["ackIds"]) ? (body["ackIds"] as unknown[]) : [];
      for (const id of ackIds) {
        const idx = queue.findIndex((m) => m.ackId === id);
        if (idx >= 0) {
          queue.splice(idx, 1);
          ackedTotal += 1;
        }
      }
      return { status: 200, body: {} };
    },
  );

  // --- Fake Chat REST (create / edit / delete) → the per-space oracle ---
  backend.registerPathRoute(
    (path) => CHAT_MESSAGE_RE.test(path),
    (ctx: RouteContext): RouteResult => {
      const match = ctx.path.match(CHAT_MESSAGE_RE);
      const space = match?.[1];
      if (space === undefined) {
        return { status: 404, body: { error: "not a chat messages path" } };
      }
      const targetId = match[2];
      const body = parseJson(ctx.body);
      const text = typeof body["text"] === "string" ? (body["text"] as string) : undefined;
      const hasCards = Array.isArray(body["cardsV2"]) && (body["cardsV2"] as unknown[]).length > 0;
      const threadName =
        typeof (body["thread"] as { name?: unknown } | undefined)?.name === "string"
          ? ((body["thread"] as { name?: string }).name as string)
          : undefined;

      if (ctx.httpMethod === "POST") {
        // messages.create — mint a message name and record the send.
        const messageId = ++outboundSeq;
        const messageName = `${space}/messages/${messageId}`;
        record({
          method: "send",
          op: "send",
          messageId,
          space,
          messageName,
          ...(text !== undefined ? { text } : {}),
          ...(hasCards ? { hasCards } : {}),
          ...(threadName !== undefined ? { threadName } : {}),
        });
        // The adapter reads res.json().name as the created message resource name.
        return { status: 200, body: { name: messageName } };
      }

      if (ctx.httpMethod === "PATCH" && targetId !== undefined) {
        const messageName = `${space}/messages/${targetId}`;
        record({
          method: "edit",
          op: "edit",
          messageId: Number(targetId) || 0,
          space,
          messageName,
          ...(text !== undefined ? { text } : {}),
          ...(hasCards ? { hasCards } : {}),
        });
        return { status: 200, body: { name: messageName } };
      }

      if (ctx.httpMethod === "DELETE" && targetId !== undefined) {
        const messageName = `${space}/messages/${targetId}`;
        record({
          method: "delete",
          op: "delete",
          messageId: Number(targetId) || 0,
          space,
          messageName,
        });
        return { status: 200, body: {} };
      }

      return { status: 405, body: { error: "unsupported chat method" } };
    },
  );

  const emulator: GoogleChatEmulator = {
    caps: googlechatCaps satisfies ChannelCaps,
    backend,
    projectNumber,

    start() {
      stopped = false;
      return backend.start();
    },

    async stop() {
      // Set before closing so an in-flight long-poll bails immediately.
      stopped = true;
      await backend.stop();
    },

    fakeServiceAccountKeyJson() {
      return JSON.stringify({
        type: "service_account",
        project_id: "test-project",
        private_key_id: EMULATOR_KID,
        private_key: saPrivateKeyPem,
        client_email: clientEmail,
        client_id: "000000000000000000000",
        token_uri: "https://oauth2.googleapis.com/token",
      });
    },

    publicJwks() {
      return { keys: [signingJwk] };
    },

    writeJwksFile(filePath) {
      writeFileSync(filePath, JSON.stringify({ keys: [signingJwk] }), "utf8");
    },

    async signInboundToken(signOpts) {
      return new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: EMULATOR_KID })
        .setIssuer(signOpts?.issuer ?? CHAT_SYSTEM_ISSUER)
        .setAudience(signOpts?.audience ?? projectNumber)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    },

    injectInbound(event) {
      const seq = ++ackSeq;
      // STANDARD base64 (not the URL-safe alphabet): the loop decodes with
      // Buffer.from(data, "base64"), so the round-trip is exact.
      const data = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
      queue.push({ ackId: `ack-${seq}`, messageId: `pubsub-msg-${seq}`, data });
    },

    outbound(space) {
      return spaces.get(space) ?? [];
    },

    lastBotReply(space) {
      const log = spaces.get(space);
      return log && log.length > 0 ? log[log.length - 1] : undefined;
    },

    resetChat(space) {
      spaces.delete(space);
    },

    tokenMintCount() {
      return mintCount;
    },

    ackedCount() {
      return ackedTotal;
    },

    pendingCount() {
      return queue.length;
    },
  };

  return emulator;
}

/**
 * Register the OUT-OF-PROCESS drive-control surface on the emulator's loopback
 * backend, so a SEPARATE driver process (a self-drive script, or a VPS launcher
 * wired to an external daemon) can (a) enqueue an inbound event onto the fake
 * subscription, (b) obtain a signed inbound Bearer — the emulator holds the
 * private key, the driver does not — and (c) read the Chat outbound oracle.
 *
 *   - POST /emu/pubsub-inject  <event JSON>                → { ok, pending }
 *   - POST /emu/sign-token     { audience?, issuer? }      → { token }
 *   - GET  /emu/outbound       ?space=&afterCount=         → { outbound, total }
 *   - GET  /emu/info                                       → { projectNumber, tokenMintCount, ackedCount, pendingCount }
 *
 * Loopback-only + test-only (the adapter never calls `/emu/*`; it only hits the
 * token / `:pull` / `:acknowledge` / `/spaces/…/messages` surfaces). No auth — the
 * surface is unreachable off 127.0.0.1 (the shared backend binds loopback only).
 */
export function registerGoogleChatDriveControl(emu: GoogleChatEmulator): void {
  emu.backend.registerPathRoute("/emu/pubsub-inject", (ctx): RouteResult => {
    const event = parseJson(ctx.body);
    emu.injectInbound(event);
    return { status: 200, body: { ok: true, pending: emu.pendingCount() } };
  });
  emu.backend.registerPathRoute("/emu/sign-token", async (ctx): Promise<RouteResult> => {
    const body = parseJson(ctx.body);
    const audience = typeof body["audience"] === "string" ? (body["audience"] as string) : undefined;
    const issuer = typeof body["issuer"] === "string" ? (body["issuer"] as string) : undefined;
    const token = await emu.signInboundToken({
      ...(audience !== undefined ? { audience } : {}),
      ...(issuer !== undefined ? { issuer } : {}),
    });
    return { status: 200, body: { token } };
  });
  emu.backend.registerPathRoute("/emu/outbound", (ctx): RouteResult => {
    const params = new URLSearchParams(ctx.query);
    const space = params.get("space") ?? "";
    const afterCount = Number(params.get("afterCount") ?? "0") || 0;
    const all = emu.outbound(space);
    return { status: 200, body: { outbound: all.slice(afterCount), total: all.length } };
  });
  emu.backend.registerPathRoute("/emu/info", (): RouteResult => {
    return {
      status: 200,
      body: {
        projectNumber: emu.projectNumber,
        tokenMintCount: emu.tokenMintCount(),
        ackedCount: emu.ackedCount(),
        pendingCount: emu.pendingCount(),
      },
    };
  });
}
