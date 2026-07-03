// SPDX-License-Identifier: Apache-2.0
/**
 * InteractiveCallbackRouter — the single server-side authority that parses,
 * looks-up-THEN-verifies, and dispatches every approval callback to
 * `ApprovalGate.resolveApproval()`.
 *
 * Channels NEVER call `ApprovalGate` directly and NEVER carry `requestId`/`sessionKey`
 * on the wire — only `shortId`. The router resolves `shortId → requestId` server-side,
 * matches `sessionKey` to reject cross-session replays, checks expiry via the injected
 * `ClockPort`, then constant-time-verifies the HMAC. `render()` delegates to the
 * `core/security` signing primitive so the renderers (which import `@comis/core`) and
 * the router share one signing implementation — no duplicated crypto, no
 * `channels → orchestrator` boundary violation.
 *
 * The route ORDER is load-bearing (verify-before-lookup defeats
 * replay rejection): the pending-table lookup proves liveness, enables replay rejection,
 * and provides the server-side `requestId`/`sessionKey`/`expiresAt`. There is NO separate
 * replay store — `resolveApproval` removing the pending entry IS the replay guard (the
 * gate drops both the by-requestId map and the by-shortId index atomically).
 *
 * @module
 */
import { ok, type Result } from "@comis/shared";
import type { ApprovalGate, ClockPort, CallbackChoice, CallbackRenderError } from "@comis/core";
import {
  parseCallbackData,
  verifyCallbackData,
  renderCallbackData,
} from "@comis/core";

/**
 * Inbound approval callback. `rawData` and `inboundUserId` are
 * attacker-controllable; `sessionKey` is orchestrator-derived from `channelKey`
 * BEFORE `route()` is called (trusted — never read from the wire).
 */
export type InboundCallback = {
  channelType: string;
  channelKey: string;
  agentId: string;
  /** Orchestrator-derived from channelKey BEFORE calling route() — trusted, never on the wire. */
  sessionKey: string;
  /** Platform-echoed signed callback payload OR a plain-text reply. */
  rawData: string;
  inboundUserId?: string;
};

/**
 * Closed result union. `requestId` is returned only to the orchestrator
 * caller — never to the wire; channels receive only the resolution `kind`.
 */
export type CallbackResolution =
  | { kind: "resolved"; requestId: string; choice: "approve" | "deny" }
  | { kind: "details_requested"; requestId: string }
  | { kind: "malformed" }
  | { kind: "invalid_signature" }
  | { kind: "expired" }
  | { kind: "ambiguous"; count: number }
  | { kind: "unknown" };

export interface InteractiveCallbackRouter {
  /** Render a signed `v1.<choice>.<shortId>.<hmac>` payload (delegates to the core primitive). */
  render(choice: "approve" | "deny" | "details", shortId: string): Result<string, CallbackRenderError>;
  /** Resolve an inbound callback to a CallbackResolution. Infallible at the Result level (never errors). */
  route(inbound: InboundCallback): Promise<Result<CallbackResolution, never>>;
}

export interface InteractiveCallbackRouterDeps {
  /** The approval gate (server-side resolution substrate — read helpers). */
  readonly gate: ApprovalGate;
  /** Returns the HMAC signing secret (injected at the daemon composition root). */
  readonly getSecret: () => string;
  /** Injected clock — expiry uses `clock.now()`, never a wall-clock global. */
  readonly clock: ClockPort;
}

/** Fallback approver identity when the channel did not supply an inbound user id. */
const UNKNOWN_APPROVER = "chat:unknown";

/** The plain-text verbs accepted on the plain-text reply branch. */
const PLAINTEXT_VERBS = new Set<CallbackChoice>(["approve", "deny", "details"]);

/** A 12-char base62 shortId (case-SENSITIVE — base62 distinguishes case). */
const SHORT_ID_RE = /^[0-9A-Za-z]{12}$/;

/** Marker prefix for a signed callback attempt (`v1.<choice>.<shortId>.<hmac>`). */
const SIGNED_PREFIX = "v1.";

/**
 * Parse a plain-text reply into a verb + optional shortId suffix, or null.
 *
 * Split-based (not a single regex) to avoid any ReDoS surface on attacker-controlled
 * `rawData` (`security/detect-unsafe-regex`): the verb is lower-cased for the
 * case-insensitive match, but the optional shortId token is compared case-sensitively
 * because base62 ids distinguish case — lower-casing the whole reply would corrupt it.
 */
function parsePlainText(
  raw: string,
): { verb: CallbackChoice; shortIdSuffix?: string } | null {
  const tokens = raw.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 2) return null;
  const verb = tokens[0]!.toLowerCase();
  if (!PLAINTEXT_VERBS.has(verb as CallbackChoice)) return null;
  const shortIdSuffix = tokens[1];
  if (shortIdSuffix !== undefined && !SHORT_ID_RE.test(shortIdSuffix)) return null;
  return { verb: verb as CallbackChoice, shortIdSuffix };
}

/**
 * Create an InteractiveCallbackRouter.
 *
 * @param deps - gate (resolution substrate), getSecret (HMAC secret accessor), clock (expiry)
 * @returns the router with `render()` + `route()`
 */
export function createInteractiveCallbackRouter(
  deps: InteractiveCallbackRouterDeps,
): InteractiveCallbackRouter {
  const { gate, getSecret, clock } = deps;

  function render(
    choice: "approve" | "deny" | "details",
    shortId: string,
  ): Result<string, CallbackRenderError> {
    // Delegate to the core/security primitive — single signing implementation.
    return renderCallbackData(getSecret(), choice as CallbackChoice, shortId);
  }

  /** Dispatch a resolved/details outcome for a known pending request. */
  function dispatch(
    choice: CallbackChoice,
    requestId: string,
    inboundUserId: string | undefined,
  ): CallbackResolution {
    if (choice === "details") {
      // Re-render expanded; the pending entry stays intact (NOT resolved).
      return { kind: "details_requested", requestId };
    }
    const approvedBy = inboundUserId ?? UNKNOWN_APPROVER;
    gate.resolveApproval(requestId, choice === "approve", approvedBy);
    return { kind: "resolved", requestId, choice };
  }

  function routeSigned(inbound: InboundCallback): CallbackResolution {
    // ORDER IS LOAD-BEARING. Do NOT reorder.
    // 1. Strict parse of the signed wire format.
    const parsed = parseCallbackData(inbound.rawData);
    if (!parsed.ok) return { kind: "malformed" };
    const { choice, shortId, hmac } = parsed.value;

    // 2. Look up the shortId in the pending table FIRST. Not found → unknown
    //    (covers replays after resolution — the pending-table removal is the guard).
    const req = gate.getRequestByShortId(shortId);
    if (req === undefined) return { kind: "unknown" };

    // 3. Cross-session guard: one room cannot act on another's pending
    //    approval. sessionKey is orchestrator-derived (trusted), never from the wire.
    if (req.sessionKey !== inbound.sessionKey) return { kind: "unknown" };

    // 4. Expiry via the injected clock. expiresAt is DERIVED, never stored.
    if (clock.now() >= req.createdAt + req.timeoutMs) return { kind: "expired" };

    // 5. Constant-time HMAC verify (length-guard-first, no throw).
    if (!verifyCallbackData(getSecret(), choice, shortId, hmac)) {
      return { kind: "invalid_signature" };
    }

    // 6. Dispatch. `choice` is already narrowed to CallbackChoice by parseCallbackData.
    return dispatch(choice, req.requestId, inbound.inboundUserId);
  }

  function routePlainText(inbound: InboundCallback): CallbackResolution {
    // Plain-text branch — HMAC SKIPPED for this branch only (plain-text channels cannot carry a
    // signed payload); replay protection still from pending-table removal,
    // and sessionKey scoping still applies via pendingForSession.
    const command = parsePlainText(inbound.rawData);
    if (command === null) return { kind: "unknown" };

    const { verb, shortIdSuffix } = command;
    const pend = gate.pendingForSession(inbound.sessionKey);

    if (shortIdSuffix !== undefined) {
      // With a suffix → match exactly that shortId within this session (none → unknown).
      const target = pend.find((r) => r.shortId === shortIdSuffix);
      if (target === undefined) return { kind: "unknown" };
      return dispatch(verb, target.requestId, inbound.inboundUserId);
    }

    // No suffix: disambiguate by the count of pending requests in this session.
    if (pend.length === 0) return { kind: "unknown" };
    if (pend.length > 1) return { kind: "ambiguous", count: pend.length };
    return dispatch(verb, pend[0]!.requestId, inbound.inboundUserId);
  }

  async function route(
    inbound: InboundCallback,
  ): Promise<Result<CallbackResolution, never>> {
    // Branch on the signed-format MARKER, not on parse success: anything beginning
    // with `v1.` is a signed-callback attempt and routes through routeSigned, where a
    // strict-parse failure yields `malformed` (a corrupted/forged signed payload must
    // NOT silently fall through to the unauthenticated plain-text branch). Only input
    // without the marker is treated as a plain-text reply.
    const resolution = inbound.rawData.startsWith(SIGNED_PREFIX)
      ? routeSigned(inbound)
      : routePlainText(inbound);
    return ok(resolution);
  }

  return { render, route };
}
