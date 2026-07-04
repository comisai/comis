// SPDX-License-Identifier: Apache-2.0
/**
 * `MsTeamsEmulator` — the fake Microsoft Teams / Bot Framework platform the REAL
 * production Teams adapter + gateway ingress talk to over loopback HTTP. Built ON
 * the generalized `http-backend` base and `extends ChannelEmulator`.
 *
 * TEAMS IS THE INVERSE OF TELEGRAM/SIGNAL. Telegram/Signal are pull channels: the
 * daemon connects OUT to the emulator (long-poll / SSE), and the rig redirects it
 * with a single `channels.<c>.{apiRoot|baseUrl}` config key. Teams is a webhook +
 * Connector channel:
 *
 *   - INBOUND is PUSH: the daemon EXPOSES `POST /channels/msteams/api/messages` on
 *     its gateway; a caller pushes a signed Bot Framework `Activity`. So the
 *     emulator does NOT serve inbound — it MINTS the signed Bearer + the activity
 *     (via `msteams-payloads.ts`) and the driver POSTs it to the daemon
 *     ({@link postActivity} is the convenience push).
 *   - INBOUND AUTH is a BF-JWT: the ingress verifies the Bearer against the Bot
 *     Framework JWKS (`login.botframework.com`), issuer `api.botframework.com`,
 *     audience = appId. The emulator holds an RS256 keypair, {@link signInboundToken}
 *     mints a token the daemon trusts when the daemon is booted with the test-only
 *     `COMIS_MSTEAMS_TEST_JWKS` seam pointing at {@link writeJwksFile}'s output
 *     (or, in an in-process scenario, `createActivityJwtValidator({ jwks })` fed
 *     {@link publicJwks}). The production remote-JWKS path is untouched.
 *   - OUTBOUND is the Connector REST API: the adapter POSTs/PUTs/DELETEs to
 *     `${serviceUrl}v3/conversations/{id}/activities`, where `serviceUrl` is taken
 *     verbatim from the inbound activity — the payloads set it to the
 *     isSafeServiceUrl-admitted host `smba.trafficmanager.net`. This emulator plays
 *     that Connector: it records every activity mutation to a per-conversation
 *     oracle (the outbound half the dual-oracle cross-check reads). The daemon's
 *     test-only `COMIS_MSTEAMS_TEST_CONNECTOR` seam (or the scenario's injected
 *     `fetchImpl` = {@link connectorRedirectFetch}) redirects the wire bytes from
 *     the real Connector host to this loopback emulator AFTER the host-allowlist
 *     gate passes — the gate itself is never relaxed.
 *   - The adapter mints a Connector token first (client-credentials POST to
 *     `login.microsoftonline.com/.../oauth2/v2.0/token`), so the emulator also
 *     plays that AAD token endpoint (returns an opaque `{access_token, expires_in}`
 *     — the token VALUE is never validated here; the emulator IS the Connector).
 *
 * It composes the shared loopback server (`createHttpBackend()`) and registers the
 * Connector + token surfaces on the base's GENERALIZED `registerPathRoute` — it
 * does NOT spin up its own `node:http` server (built ON the base, loopback-only).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production runtime
 * change. `@comis/*` types are imported `type`-only elsewhere in the emulator
 * package; this file imports none.
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
import { msteamsCaps } from "./msteams-caps.js";
import { MSTEAMS_TEST_TENANT_ID } from "./msteams-payloads.js";

/** Bot Framework activity issuer — the emulator signs inbound tokens with this. */
const BF_ISSUER = "https://api.botframework.com";
/** The signing key id, stamped on both the JWK and every minted token header. */
const EMULATOR_KID = "msteams-emulator-key-1";
/** The default bot app id the emulator signs tokens for (the inbound `aud`). */
const DEFAULT_APP_ID = "test-app-id";
/** The AAD token-endpoint path suffix the adapter's client-credentials mint hits. */
const TOKEN_PATH_SUFFIX = "/oauth2/v2.0/token";
/** The Connector create/edit/delete/typing path prefix. */
const CONNECTOR_PATH_PREFIX = "/v3/conversations/";
/**
 * The exact Bot Framework Connector service hosts (+ the AAD login host) the
 * daemon's outbound goes to. {@link connectorRedirectFetch} rewrites these to the
 * loopback emulator; every other host passes through untouched.
 */
const REDIRECT_HOSTS = new Set([
  "smba.trafficmanager.net",
  "botframework.azure.cn",
  "login.microsoftonline.com",
]);

/**
 * A recorded outbound Connector mutation (the Teams superset of the shared
 * {@link RecordedOutbound} — assignable to it, so the control-api + dual-oracle
 * read the `{ method, messageId, text }` subset unchanged).
 */
export interface MsTeamsRecordedOutbound extends RecordedOutbound {
  /** The Connector operation: create (send) / edit / delete / typing. */
  readonly op: "send" | "edit" | "delete" | "typing";
  /** The conversation id the mutation targeted (decoded from the REST path). */
  readonly conversationId: string;
  /** The activity `type` on the body (`"message"` | `"typing"`). */
  readonly activityType: string;
  /** The parent-activity id a threaded reply set (`replyToId`), when present. */
  readonly replyToId?: string;
  /** True when the body carried an Adaptive Card attachment. */
  readonly hasCard?: boolean;
  /** True when the body carried an inline image (`data:` / `image/*`) attachment. */
  readonly hasImageAttachment?: boolean;
}

/** Options for {@link createMsTeamsEmulator}. */
export interface CreateMsTeamsEmulatorOptions {
  /**
   * The bot app id the emulator signs inbound tokens for (the token `aud`, which
   * must equal the daemon's `channels.msteams.appId`). Defaults to
   * {@link DEFAULT_APP_ID}.
   */
  readonly appId?: string;
  /** The single-tenant directory id (the token-endpoint path segment). Defaults to {@link MSTEAMS_TEST_TENANT_ID}. */
  readonly tenantId?: string;
}

/**
 * `MsTeamsEmulator` — `ChannelEmulator` + the Teams-specific inbound-mint / push
 * verbs + the Connector outbound oracle. `start()`/`stop()` delegate to the
 * http-backend base.
 *
 * A Teams "chat" is the conversation id STRING (the mapper's stripped
 * `channelId`); the per-conversation oracle keys on it.
 */
export interface MsTeamsEmulator extends ChannelEmulator {
  /**
   * The SHARED loopback http-backend base this emulator composes. Exposed so the
   * rig / control API can register additional routes on the SAME loopback port.
   * The emulator owns the base's lifecycle — `start()`/`stop()` delegate to it;
   * callers MUST NOT call `backend.start()`/`stop()` directly.
   */
  readonly backend: HttpBackend;
  /** The configured bot app id (the inbound token `aud`). */
  readonly appId: string;
  /** The configured single-tenant directory id (the token-endpoint path segment). */
  readonly tenantId: string;
  /**
   * The public JWKS the daemon's inbound validator verifies against (a single
   * RS256 signing key). Feed it to `createActivityJwtValidator({ jwks:
   * createLocalJWKSet(publicJwks()) })` in an in-process scenario, or persist it
   * with {@link writeJwksFile} for the daemon's `COMIS_MSTEAMS_TEST_JWKS` seam.
   */
  publicJwks(): { keys: JsonWebKey[] };
  /** Persist {@link publicJwks} to `filePath` (the daemon `COMIS_MSTEAMS_TEST_JWKS` seam reads it). */
  writeJwksFile(filePath: string): void;
  /**
   * Mint a signed Bot Framework activity Bearer (`iss=api.botframework.com`,
   * `aud=appId`, RS256, 5-min expiry) the daemon's ingress validator accepts when
   * booted with the emulator's JWKS. `appIdOverride` signs for a different
   * audience (to exercise the wrong-audience reject path).
   */
  signInboundToken(appIdOverride?: string): Promise<string>;
  /**
   * Convenience inbound PUSH: sign a Bearer and POST `activity` to the daemon's
   * ingress at `${ingressBaseUrl}/channels/msteams/api/messages`. Returns the ack
   * status (202 for a message, 200 for a lone invoke, 401 on an auth reject).
   * `ingressBaseUrl` is the daemon gateway origin (e.g. `http://127.0.0.1:4766`).
   */
  postActivity(
    ingressBaseUrl: string,
    activity: unknown,
    opts?: { tokenOverride?: string; appIdOverride?: string },
  ): Promise<{ status: number; body: string }>;
  /** The full recorded outbound Connector log for a conversation, in order (the oracle). `[]` for an unseen conversation. */
  outbound(conversationId: string): readonly MsTeamsRecordedOutbound[];
  /** The most recent recorded outbound for a conversation, or `undefined` (the dual-oracle read). */
  lastBotReply(conversationId: string): MsTeamsRecordedOutbound | undefined;
  /** Clear a conversation's recorded outbound (per-test isolation). */
  resetChat(conversationId: string): void;
  /** How many times the fake AAD token endpoint was hit (proves the client-credentials mint ran). */
  tokenMintCount(): number;
}

/**
 * Build a `fetch` that redirects the Bot Framework Connector hosts (and the AAD
 * login host) to a loopback base, keeping the path + query verbatim — the
 * programmatic equivalent of a hosts-override. Every other host passes through
 * untouched. Used by the scenario proof's injected `fetchImpl` and mirrored by
 * the daemon's `COMIS_MSTEAMS_TEST_CONNECTOR` seam. The `isSafeServiceUrl` host
 * allowlist is NOT relaxed — it still validates the real host on the activity's
 * serviceUrl; only the network egress is redirected AFTER the gate passes.
 */
export function connectorRedirectFetch(loopbackBase: string): typeof fetch {
  const base = new URL(loopbackBase);
  const redirect = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const target = new URL(href);
    if (REDIRECT_HOSTS.has(target.hostname.toLowerCase())) {
      target.protocol = base.protocol;
      target.host = base.host;
      return fetch(target.toString(), init);
    }
    return fetch(input as string | URL, init);
  };
  return redirect as typeof fetch;
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

/** Inspect an activity body's attachments for a card / inline image (for the oracle). */
function classifyAttachments(body: Record<string, unknown>): {
  hasCard: boolean;
  hasImageAttachment: boolean;
} {
  const attachments = Array.isArray(body["attachments"])
    ? (body["attachments"] as Array<Record<string, unknown>>)
    : [];
  let hasCard = false;
  let hasImageAttachment = false;
  for (const att of attachments) {
    const ct = typeof att["contentType"] === "string" ? (att["contentType"] as string) : "";
    if (ct === "application/vnd.microsoft.card.adaptive") hasCard = true;
    const url = typeof att["contentUrl"] === "string" ? (att["contentUrl"] as string) : "";
    if (ct.startsWith("image/") || url.startsWith("data:image/")) hasImageAttachment = true;
  }
  return { hasCard, hasImageAttachment };
}

/**
 * Create the Microsoft Teams wire emulator on the shared http-backend base.
 *
 * Mirrors `createSignalEmulator`: composes `createHttpBackend()`, registers the
 * Connector + token surfaces on the base's generalized path routes, and returns
 * an object literal whose `caps`/`start`/`stop` delegate to the base + the
 * per-conversation outbound oracle + the inbound mint/push verbs. The RS256
 * signing keypair is generated SYNCHRONOUSLY at construction (node:crypto), so
 * the factory stays sync like the Telegram/Signal factories.
 */
export function createMsTeamsEmulator(
  opts: CreateMsTeamsEmulatorOptions = {},
): MsTeamsEmulator {
  const backend: HttpBackend = createHttpBackend();
  const appId = opts.appId ?? DEFAULT_APP_ID;
  const tenantId = opts.tenantId ?? MSTEAMS_TEST_TENANT_ID;

  // The inbound-signing keypair. Generated synchronously so the factory is sync
  // (the rig's RIG_CHANNELS.make is sync). RS256 = the algorithm the adapter's
  // validator pins (msteams-auth.ts:88).
  const { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject } =
    generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  // Stamp the kid/alg/use the local JWKS matches on (jose selects the key by kid).
  const signingJwk: JsonWebKey = { ...publicJwk, kid: EMULATOR_KID, alg: "RS256", use: "sig" };

  // Per-conversation ORACLE state (the outbound Connector mutation log).
  const conversations = new Map<string, MsTeamsRecordedOutbound[]>();
  // Strictly-monotonic outbound activity-id source (the created-activity `id` the
  // adapter reads back as `metadata.teamsActivityId`). Numeric so it fits the
  // shared RecordedOutbound.messageId; returned to the adapter as its string form.
  let outboundSeq = 5_000;
  let mintCount = 0;

  function convLog(conversationId: string): MsTeamsRecordedOutbound[] {
    let log = conversations.get(conversationId);
    if (log === undefined) {
      log = [];
      conversations.set(conversationId, log);
    }
    return log;
  }

  function record(ro: MsTeamsRecordedOutbound): void {
    convLog(ro.conversationId).push(ro);
  }

  // --- Fake AAD token endpoint (the client-credentials mint) ---
  // POST /<tenant>/oauth2/v2.0/token → an opaque access token. The emulator IS
  // the Connector, so it never validates the token it hands out — but the adapter
  // must obtain one before it POSTs, so this must answer 200 with a token + expiry.
  backend.registerPathRoute(
    (path) => path.endsWith(TOKEN_PATH_SUFFIX),
    (): RouteResult => {
      mintCount += 1;
      return {
        status: 200,
        body: { access_token: "emulator-connector-token", expires_in: 3600 },
      };
    },
  );

  // --- Fake Bot Framework Connector (create / edit / delete / typing) ---
  backend.registerPathRoute(CONNECTOR_PATH_PREFIX, (ctx: RouteContext): RouteResult => {
    // /v3/conversations/{encConvId}/activities[/{encActId}]
    const parts = ctx.path.split("/"); // ["","v3","conversations",enc,"activities",encAct?]
    const encConv = parts[3];
    if (encConv === undefined || parts[4] !== "activities") {
      return { status: 404, body: { error: "not a connector activities path" } };
    }
    const conversationId = decodeURIComponent(encConv);
    const encAct = parts[5];
    const body = parseJson(ctx.body);
    const activityType = typeof body["type"] === "string" ? (body["type"] as string) : "";
    const text = typeof body["text"] === "string" ? (body["text"] as string) : undefined;
    const replyToId =
      typeof body["replyToId"] === "string" ? (body["replyToId"] as string) : undefined;

    if (ctx.httpMethod === "POST" && encAct === undefined) {
      // Create-activity OR a typing keepalive (both POST to .../activities).
      if (activityType === "typing") {
        record({
          method: "typing",
          op: "typing",
          messageId: 0,
          conversationId,
          activityType,
        });
        return { status: 200, body: {} };
      }
      const messageId = ++outboundSeq;
      const { hasCard, hasImageAttachment } = classifyAttachments(body);
      record({
        method: "send",
        op: "send",
        messageId,
        conversationId,
        activityType: activityType || "message",
        ...(text !== undefined ? { text } : {}),
        ...(replyToId !== undefined ? { replyToId } : {}),
        ...(hasCard ? { hasCard } : {}),
        ...(hasImageAttachment ? { hasImageAttachment } : {}),
      });
      // The adapter reads res.json().id as the created activity id (string).
      return { status: 200, body: { id: String(messageId) } };
    }

    if (ctx.httpMethod === "PUT" && encAct !== undefined) {
      const activityId = decodeURIComponent(encAct);
      record({
        method: "edit",
        op: "edit",
        messageId: Number(activityId) || 0,
        conversationId,
        activityType: activityType || "message",
        ...(text !== undefined ? { text } : {}),
      });
      return { status: 200, body: { id: activityId } };
    }

    if (ctx.httpMethod === "DELETE" && encAct !== undefined) {
      const activityId = decodeURIComponent(encAct);
      record({
        method: "delete",
        op: "delete",
        messageId: Number(activityId) || 0,
        conversationId,
        activityType: "message",
      });
      return { status: 200, body: {} };
    }

    return { status: 405, body: { error: "unsupported connector method" } };
  });

  const emulator: MsTeamsEmulator = {
    caps: msteamsCaps satisfies ChannelCaps,
    backend,
    appId,
    tenantId,

    start() {
      return backend.start();
    },

    async stop() {
      await backend.stop();
    },

    publicJwks() {
      return { keys: [signingJwk] };
    },

    writeJwksFile(filePath) {
      writeFileSync(filePath, JSON.stringify({ keys: [signingJwk] }), "utf8");
    },

    async signInboundToken(appIdOverride) {
      return new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: EMULATOR_KID })
        .setIssuer(BF_ISSUER)
        .setAudience(appIdOverride ?? appId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    },

    async postActivity(ingressBaseUrl, activity, postOpts) {
      const token =
        postOpts?.tokenOverride ??
        (await this.signInboundToken(postOpts?.appIdOverride));
      const url = `${ingressBaseUrl.replace(/\/$/, "")}/channels/msteams/api/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(activity),
      });
      const respBody = await res.text();
      return { status: res.status, body: respBody };
    },

    outbound(conversationId) {
      return conversations.get(conversationId) ?? [];
    },

    lastBotReply(conversationId) {
      const log = conversations.get(conversationId);
      return log && log.length > 0 ? log[log.length - 1] : undefined;
    },

    resetChat(conversationId) {
      conversations.delete(conversationId);
    },

    tokenMintCount() {
      return mintCount;
    },
  };

  return emulator;
}

/**
 * Register the OUT-OF-PROCESS drive-control surface on the emulator's loopback
 * backend, so a SEPARATE driver process (the self-drive `msteams-drive.mjs`, or a
 * VPS launcher wired to an external daemon) can (a) obtain a signed inbound Bearer
 * — the emulator holds the private key, the driver does not — and (b) read the
 * Connector outbound oracle. The Telegram analog is `registerControlApi(emu.backend)`;
 * Teams' inbound is a PUSH, so the driver signs here then POSTs the activity to the
 * daemon ingress itself.
 *
 *   - POST /emu/sign-token   { appId? }                       → { token }
 *   - GET  /emu/outbound     ?conversationId=&afterCount=     → { outbound, total }
 *   - GET  /emu/info                                          → { appId, tokenMintCount }
 *
 * Loopback-only + test-only (the daemon never calls `/emu/*`; it only hits
 * `/v3/conversations/*` + the token path). No auth — the surface is unreachable
 * off 127.0.0.1 (the shared backend binds loopback only).
 */
export function registerMsTeamsDriveControl(emu: MsTeamsEmulator): void {
  emu.backend.registerPathRoute("/emu/sign-token", async (ctx): Promise<RouteResult> => {
    const body = parseJson(ctx.body);
    const appIdOverride =
      typeof body["appId"] === "string" ? (body["appId"] as string) : undefined;
    const token = await emu.signInboundToken(appIdOverride);
    return { status: 200, body: { token } };
  });
  emu.backend.registerPathRoute("/emu/outbound", (ctx): RouteResult => {
    const params = new URLSearchParams(ctx.query);
    const conversationId = params.get("conversationId") ?? "";
    const afterCount = Number(params.get("afterCount") ?? "0") || 0;
    const all = emu.outbound(conversationId);
    return { status: 200, body: { outbound: all.slice(afterCount), total: all.length } };
  });
  emu.backend.registerPathRoute("/emu/info", (): RouteResult => {
    return { status: 200, body: { appId: emu.appId, tokenMintCount: emu.tokenMintCount() } };
  });
}
