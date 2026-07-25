// SPDX-License-Identifier: Apache-2.0
/**
 * Signing-secret lifecycle + interactive-callback composition seam.
 *
 * The 32-byte `activity.interactiveCallbackSigningSecret` is the keystone of every
 * signed channel callback: the renderers sign `callback_data` with it (via the
 * injected `SignCallbackData`) and the orchestrator's `InteractiveCallbackRouter`
 * verifies against it. This module owns its generate/read lifecycle at the daemon
 * composition root:
 *
 *   - encrypted store ENABLED: generate once (`randomBytes(32).toString("base64url")`)
 *     and persist via `SecretStorePort.set`; read it back via `getDecrypted` on
 *     every subsequent start → STABLE across restart.
 *   - store DISABLED (`undefined`, the default — schema-secrets `enabled:false`):
 *     generate an in-memory secret per process. Documented fallback: in-flight
 *     5-min approval buttons invalidate across restart (acceptable — approvals are
 *     time-bounded). A corrupted/wrong-key store (getDecrypted error) also falls
 *     back to a fresh in-memory secret rather than crashing boot.
 *
 * The secret value NEVER appears in a log line; only a boolean
 * "generated vs read" + the source is logged. The secret name is on the
 * `platformSecretNames` deny surface (see `INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME`
 * in `@comis/core`) so user-facing secret-ref tools can never resolve it.
 *
 * `bindSignCallbackData` turns the resolved secret into the `SignCallbackData`
 * closure the channel renderers consume (delegating to `@comis/core`'s
 * `signCallbackData`) — the secret is closure-captured and never crosses into the
 * channels package as a value.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import {
  signCallbackData,
  generateStrongToken,
  INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME,
  formatSessionKey,
} from "@comis/core";
import type {
  SecretStorePort,
  ComisLogger,
  ApprovalGate,
  ClockPort,
  ActivityEvent,
  AppConfig,
} from "@comis/core";
import type { SignCallbackData, MintApprovalLink } from "@comis/channels";
import { createInteractiveCallbackRouter } from "@comis/orchestrator";
import type { GraphReportTargetStore, InteractiveCallbackRouter } from "@comis/orchestrator";
import {
  insertPendingApprovalToken,
  type PendingApprovalToken,
  type ApprovalLinkChoice,
} from "@comis/gateway";

/** Generate a fresh 32-byte base64url signing secret (mirrors token-generator). */
function generateSigningSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Resolve the interactive-callback signing secret at the daemon composition root.
 *
 * Synchronous: `SecretStorePort.set`/`getDecrypted` are synchronous (the
 * eager-decrypt-at-boot pattern), so this returns the secret directly.
 *
 * @param secretStore - the encrypted store, or `undefined` when secrets are disabled
 * @param logger - composition-root logger (the secret value is NEVER logged)
 * @returns the 32-byte base64url signing secret
 */
export function resolveInteractiveCallbackSigningSecret(
  secretStore: SecretStorePort | undefined,
  logger: ComisLogger,
): string {
  if (secretStore === undefined) {
    // Disabled store: per-process in-memory secret (documented fallback).
    logger.debug(
      {
        secretName: INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME,
        source: "in-memory",
        submodule: "interactive-callback",
      },
      "Interactive-callback signing secret generated in memory (encrypted store disabled)",
    );
    return generateSigningSecret();
  }

  const existing = secretStore.getDecrypted(INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME);
  // Treat an EMPTY string the same as absent. HMAC accepts an empty key, so a
  // degenerate/hand-edited store row decrypting to "" would not break verification —
  // it would collapse the keyspace to a publicly-computable constant (empty key),
  // making every callback forgeable. Reject it so the regenerate-and-persist path runs.
  if (existing.ok && existing.value !== undefined && existing.value.length > 0) {
    logger.debug(
      {
        secretName: INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME,
        source: "store",
        generated: false,
        submodule: "interactive-callback",
      },
      "Interactive-callback signing secret read from store",
    );
    return existing.value;
  }

  // Absent (first start) OR a decryption error (corrupted/wrong key): generate a
  // fresh secret. On a clean store, persist it so it is stable across restart; on
  // a decryption error, fall back to in-memory rather than crashing boot.
  const secret = generateSigningSecret();
  if (!existing.ok) {
    logger.warn(
      {
        secretName: INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME,
        source: "in-memory",
        errorKind: "internal" as const,
        hint: "The signing secret could not be decrypted; using a per-process secret. In-flight approval buttons will invalidate. Check the secrets master key.",
        submodule: "interactive-callback",
      },
      "Interactive-callback signing secret decryption failed; using in-memory fallback",
    );
    return secret;
  }

  const written = secretStore.set(INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME, secret);
  if (!written.ok) {
    logger.warn(
      {
        secretName: INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME,
        source: "in-memory",
        errorKind: "internal" as const,
        hint: "The signing secret could not be persisted; using a per-process secret for this run. In-flight approval buttons will invalidate on restart.",
        submodule: "interactive-callback",
      },
      "Interactive-callback signing secret persist failed; using in-memory fallback",
    );
    return secret;
  }

  logger.debug(
    {
      secretName: INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME,
      source: "store",
      generated: true,
      submodule: "interactive-callback",
    },
    "Interactive-callback signing secret generated and persisted",
  );
  return secret;
}

/**
 * Bind a resolved signing secret into the `SignCallbackData` closure the channel
 * renderers consume. The secret is closure-captured here at the composition root
 * and never passed into the channels package as a value.
 */
export function bindSignCallbackData(secret: string): SignCallbackData {
  return (choice, shortId) => signCallbackData(secret, choice, shortId);
}

/** Derive the public base URL for approval links from gateway host/port/tls. */
function gatewayBaseUrl(gateway: AppConfig["gateway"]): string {
  const scheme = gateway.tls !== undefined ? "https" : "http";
  return `${scheme}://${gateway.host}:${gateway.port}`;
}

/**
 * The interactive-callback composition-root bundle. Threaded from the
 * daemon into the channel renderers + the gateway route:
 *   - `signCallbackData` → button-capable renderers (Telegram/Discord/Slack/LINE).
 *   - `mintApprovalLink` → the Email DigestOnly renderer (single-use link).
 *   - `tokens` + `resolveApproval` → the gateway approval-token route deps.
 *   - `router` → the orchestrator's InteractiveCallbackRouter (button + plain-text
 *     callbacks), wired to the same gate + secret the email link resolves against.
 */
export interface InteractiveCallbackWiring {
  signCallbackData: SignCallbackData;
  mintApprovalLink: MintApprovalLink;
  router: InteractiveCallbackRouter;
  tokens: Map<string, PendingApprovalToken>;
  resolveApproval: (entry: PendingApprovalToken) => Promise<boolean>;
}

/**
 * Build the full interactive-callback wiring at the daemon composition root.
 * Accepts the signing secret resolved before approval-gate construction, binds
 * the renderer signer, constructs the InteractiveCallbackRouter
 * over the SAME gate + secret + clock, and produces the Email single-use link
 * minter + the gateway-route `resolveApproval` that consumes a minted token.
 *
 * The minted email link carries an OPAQUE `generateStrongToken()` (384-bit) — NOT
 * the signed HMAC wire format (which would leak into a mail body). The token map
 * entry records the shortId, choice, and immutable callback owner; on the first GET the gateway route hands the
 * consumed entry to `resolveApproval`, which re-renders the signed payload
 * server-side and routes it through the router (lookup → session → expiry → verify
 * → dispatch). Both the email-link path and the chat-button path resolve through
 * the one router + one gate — no duplicate resolution authority.
 */
export function createInteractiveCallbackWiring(deps: {
  signingSecret: string;
  approvalGate: ApprovalGate;
  clock: ClockPort;
  config: AppConfig;
  logger: ComisLogger;
  graphReportStore?: GraphReportTargetStore;
}): InteractiveCallbackWiring {
  const { signingSecret: secret, approvalGate, clock, config, logger, graphReportStore } = deps;
  const sign = bindSignCallbackData(secret);

  const router = createInteractiveCallbackRouter({
    gate: approvalGate,
    getSecret: () => secret,
    clock,
    ...(graphReportStore === undefined ? {} : { graphReportStore }),
  });

  const tokens = new Map<string, PendingApprovalToken>();
  const baseUrl = gatewayBaseUrl(config.gateway);
  const submodule = logger.child({ submodule: "interactive-callback" });

  // Mint a single-use approval link for a kind:"approval" event. Email shows one
  // affordance, so we mint the "approve" link (deny is reachable via the same
  // route with a deny-token — but the primary failure-digest CTA is approve).
  // The token is opaque; the shortId is the server-side correlation only.
  const mintApprovalLink: MintApprovalLink = (event: ActivityEvent) => {
    const approval = event.approval;
    if (approval === undefined) return undefined;
    const request = approvalGate.getRequestByShortId(approval.shortId);
    if (
      request === undefined
      || request.agentId !== event.agentId
    ) return undefined;
    const choice: ApprovalLinkChoice = "approve";
    const token = generateStrongToken();
    insertPendingApprovalToken(
      tokens,
      token,
      {
        shortId: approval.shortId,
        choice,
        tenantId: request.tenantId,
        conversationRef: request.conversationRef,
        resolvingPrincipalId: request.resolvingPrincipalId,
        inboundUserId: request.callbackOwner.userId,
        ...(request.callbackOwner.threadId === undefined ? {} : { threadId: request.callbackOwner.threadId }),
        channelType: request.callbackOwner.channelType,
        channelKey: request.callbackOwner.channelKey,
        agentId: request.agentId,
      },
      // ComisLogger is structurally assignable to the gateway's GatewayLogger
      // (same trace/debug/info/warn/error shape).
      submodule,
    );
    // safePath is for filesystem paths; the URL is assembled from trusted config
    // host/port + an opaque token, so a plain template is correct here.
    return `${baseUrl}/approve/${token}`;
  };

  // Resolve a consumed token by re-rendering its signed payload and routing it
  // through the SAME router the chat buttons use. The token is already revoked by
  // the gateway route before this is called (single-use), so a failure here never
  // re-arms it. Returns true iff the router resolved the approval.
  const resolveApproval = async (entry: PendingApprovalToken): Promise<boolean> => {
    const rendered = router.render(entry.choice, entry.shortId);
    if (!rendered.ok) return false;
    const displaySessionKey = formatSessionKey({
      tenantId: entry.tenantId,
      agentId: entry.agentId,
      userId: entry.inboundUserId,
      channelId: entry.channelKey,
      ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
    });
    const result = await router.route({
      tenantId: entry.tenantId,
      channelType: entry.channelType,
      channelKey: entry.channelKey,
      ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
      agentId: entry.agentId,
      conversationRef: entry.conversationRef,
      resolvingPrincipalId: entry.resolvingPrincipalId,
      sessionKey: displaySessionKey,
      rawData: rendered.value,
      inboundUserId: entry.inboundUserId,
    });
    // route() is Result<_, never> — always ok; inspect the resolution kind.
    return result.ok && result.value.kind === "resolved";
  };

  return { signCallbackData: sign, mintApprovalLink, router, tokens, resolveApproval };
}
