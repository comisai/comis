// SPDX-License-Identifier: Apache-2.0
/**
 * InteractiveCallbackRouter — the single server-side authority that parses,
 * looks-up-THEN-verifies, and dispatches every approval callback to
 * `ApprovalGate.resolveApproval()`.
 *
 * Channels NEVER call `ApprovalGate` directly and NEVER carry `requestId`/`sessionKey`
 * on the wire — only `shortId`. The router resolves `shortId → requestId` server-side,
 * matches `sessionKey` and `agentId` to reject cross-principal replays, checks expiry via the injected
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
import { createHmac } from "node:crypto";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type {
  ApprovalGate,
  ApprovalRequest,
  ClockPort,
  CallbackChoice,
  CallbackRenderError,
} from "@comis/core";
import {
  parseFormattedSessionKey,
  parseCallbackData,
  verifyCallbackData,
  renderCallbackData,
} from "@comis/core";

/**
 * Inbound approval callback. `rawData` and `inboundUserId` are
 * attacker-controllable; `agentId` and `sessionKey` are orchestrator-resolved
 * before `route()` is called (trusted — never read from the wire).
 */
export type InboundCallback = {
  tenantId: string;
  channelType: string;
  channelKey: string;
  threadId?: string;
  /** Agent selected by the inbound router before callback dispatch. */
  agentId: string;
  /** Orchestrator-derived from channelKey BEFORE calling route() — trusted, never on the wire. */
  sessionKey: string;
  /** Platform-echoed signed callback payload OR a plain-text reply. */
  rawData: string;
  inboundUserId: string;
};

/**
 * Closed result union. `requestId` is returned only to the orchestrator
 * caller — never to the wire; channels receive only the resolution `kind`.
 */
export type CallbackResolution =
  | { kind: "resolved"; requestId: string; choice: "approve" | "deny" }
  | { kind: "details_requested"; requestId: string }
  | { kind: "graph_report_requested"; graphId: string }
  | { kind: "malformed" }
  | { kind: "invalid_signature" }
  | { kind: "expired" }
  | { kind: "ambiguous"; count: number }
  | { kind: "unknown" };

export interface InteractiveCallbackRouter {
  /** Render a signed `v1.<choice>.<shortId>.<hmac>` payload (delegates to the core primitive). */
  render(choice: "approve" | "deny" | "details", shortId: string): Result<string, CallbackRenderError>;
  /** Register an owner-bound graph report target and return its signed one-use callback payload. */
  registerGraphReport(
    registration: GraphReportCallbackRegistration,
  ): Result<string, GraphReportRegistrationError>;
  /** Resolve an inbound callback to a CallbackResolution. Infallible at the Result level (never errors). */
  route(inbound: InboundCallback): Promise<Result<CallbackResolution, never>>;
}

/** Server-side graph report target. None of these ownership fields ride on the wire. */
export interface GraphReportCallbackRegistration {
  graphId: string;
  tenantId: string;
  userId: string;
  sessionKey: string;
  agentId: string;
  channelType: string;
  channelKey: string;
  expiresAt: number;
}

/** Fail-closed graph callback registration outcomes. */
export type GraphReportRegistrationError =
  | { kind: "invalid_owner" }
  | { kind: "expired" }
  | { kind: "capacity" }
  | { kind: "collision" }
  | { kind: "unavailable" };

export interface InteractiveCallbackRouterDeps {
  /** The approval gate (server-side resolution substrate — read helpers). */
  readonly gate: ApprovalGate;
  /** Returns the HMAC signing secret (injected at the daemon composition root). */
  readonly getSecret: () => string;
  /** Injected clock — expiry uses `clock.now()`, never a wall-clock global. */
  readonly clock: ClockPort;
  /** Optional durable target registry. Required when report buttons must survive daemon restart. */
  readonly graphReportStore?: GraphReportTargetStore;
}

/** Synchronous durability boundary used before a report callback is exposed or consumed. */
export interface GraphReportTargetStore {
  load(): Result<readonly unknown[], Error>;
  replace(
    registrations: readonly GraphReportCallbackRegistration[],
  ): Result<void, GraphReportStoreReplaceError>;
}

/** Whether a failed replacement became the process-visible authority before durability failed. */
export interface GraphReportStoreReplaceError {
  cause: Error;
  snapshot: "unchanged" | "visible";
}

/** The plain-text verbs accepted on the plain-text reply branch. */
const PLAINTEXT_VERBS = new Set<CallbackChoice>(["approve", "deny", "details"]);

/** A 12-char base62 shortId (case-SENSITIVE — base62 distinguishes case). */
const SHORT_ID_RE = /^[0-9A-Za-z]{12}$/;

/** Marker prefix for a signed callback attempt (`v1.<choice>.<shortId>.<hmac>`). */
const SIGNED_PREFIX = "v1.";

/** The graph coordinator retains at most 100 runs; keep headroom without an unbounded target map. */
const MAX_GRAPH_REPORT_TARGETS = 256;
const GRAPH_REPORT_SHORT_ID_LENGTH = 12;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE62_MODULUS = 62n ** BigInt(GRAPH_REPORT_SHORT_ID_LENGTH);

function canonicalGraphReportIdentity(
  registration: GraphReportCallbackRegistration,
): string {
  return JSON.stringify({
    agentId: registration.agentId,
    channelKey: registration.channelKey,
    channelType: registration.channelType,
    graphId: registration.graphId,
    kind: "graph_report",
    sessionKey: registration.sessionKey,
    tenantId: registration.tenantId,
    userId: registration.userId,
  });
}

function graphReportShortId(
  secret: string,
  registration: GraphReportCallbackRegistration,
): Result<string, Error> {
  return tryCatch(() => {
    const digest = createHmac("sha256", secret)
      .update(canonicalGraphReportIdentity(registration))
      .digest();
    let value = 0n;
    for (const byte of digest.subarray(0, 9)) {
      value = (value << 8n) | BigInt(byte);
    }
    value %= BASE62_MODULUS;
    let shortId = "";
    for (let index = 0; index < GRAPH_REPORT_SHORT_ID_LENGTH; index++) {
      shortId = BASE62.charAt(Number(value % 62n)) + shortId;
      value /= 62n;
    }
    return shortId;
  });
}

function sameGraphReportIdentity(
  left: GraphReportCallbackRegistration,
  right: GraphReportCallbackRegistration,
): boolean {
  return canonicalGraphReportIdentity(left) === canonicalGraphReportIdentity(right);
}

function parseStoredGraphReportRegistration(raw: unknown): GraphReportCallbackRegistration | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.graphId !== "string"
    || typeof candidate.tenantId !== "string"
    || typeof candidate.userId !== "string"
    || typeof candidate.sessionKey !== "string"
    || typeof candidate.agentId !== "string"
    || typeof candidate.channelType !== "string"
    || typeof candidate.channelKey !== "string"
    || typeof candidate.expiresAt !== "number"
  ) return undefined;
  return {
    graphId: candidate.graphId,
    tenantId: candidate.tenantId,
    userId: candidate.userId,
    sessionKey: candidate.sessionKey,
    agentId: candidate.agentId,
    channelType: candidate.channelType,
    channelKey: candidate.channelKey,
    expiresAt: candidate.expiresAt,
  };
}

function graphReportOwnerIsValid(registration: GraphReportCallbackRegistration): boolean {
  const parsedSession = parseFormattedSessionKey(registration.sessionKey);
  return parsedSession !== undefined
    && parsedSession.tenantId === registration.tenantId
    && parsedSession.userId === registration.userId
    && parsedSession.channelId === registration.channelKey
    && registration.graphId.length > 0
    && registration.agentId.length > 0
    && registration.channelType.length > 0
    && registration.channelKey.length > 0
    && Number.isSafeInteger(registration.expiresAt);
}

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

function inboundPrincipalIsConsistent(inbound: InboundCallback): boolean {
  const session = parseFormattedSessionKey(inbound.sessionKey);
  return session !== undefined
    && typeof inbound.tenantId === "string"
    && inbound.tenantId.length > 0
    && typeof inbound.inboundUserId === "string"
    && inbound.inboundUserId.length > 0
    && typeof inbound.channelType === "string"
    && inbound.channelType.length > 0
    && typeof inbound.channelKey === "string"
    && inbound.channelKey.length > 0
    && typeof inbound.agentId === "string"
    && inbound.agentId.length > 0
    && session.tenantId === inbound.tenantId
    && session.userId === inbound.inboundUserId
    && session.channelId === inbound.channelKey
    && session.threadId === inbound.threadId;
}

export function approvalRequestIsOwnedByInbound(
  request: ApprovalRequest,
  inbound: InboundCallback,
): boolean {
  const owner = request.callbackOwner;
  return inboundPrincipalIsConsistent(inbound)
    && request.sessionKey === inbound.sessionKey
    && request.agentId === inbound.agentId
    && owner.tenantId === inbound.tenantId
    && owner.userId === inbound.inboundUserId
    && owner.channelType === inbound.channelType
    && owner.channelKey === inbound.channelKey
    && owner.threadId === inbound.threadId;
}

function graphReportIsOwnedByInbound(
  report: GraphReportCallbackRegistration,
  inbound: InboundCallback,
): boolean {
  return inboundPrincipalIsConsistent(inbound)
    && report.sessionKey === inbound.sessionKey
    && report.agentId === inbound.agentId
    && report.tenantId === inbound.tenantId
    && report.userId === inbound.inboundUserId
    && report.channelType === inbound.channelType
    && report.channelKey === inbound.channelKey;
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
  const { gate, getSecret, clock, graphReportStore } = deps;
  const graphReports = new Map<string, GraphReportCallbackRegistration>();
  let graphReportStoreAvailable = true;

  if (graphReportStore !== undefined) {
    const loaded = graphReportStore.load();
    const secret = tryCatch(() => getSecret());
    if (!loaded.ok || !secret.ok) {
      graphReportStoreAvailable = false;
    } else {
      for (const raw of loaded.value) {
        const registration = parseStoredGraphReportRegistration(raw);
        if (registration === undefined || !graphReportOwnerIsValid(registration)) {
          graphReportStoreAvailable = false;
          graphReports.clear();
          break;
        }
        if (registration.expiresAt <= clock.now()) continue;
        const derived = graphReportShortId(secret.value, registration);
        if (!derived.ok || graphReports.has(derived.value) || gate.getRequestByShortId(derived.value) !== undefined) {
          graphReportStoreAvailable = false;
          graphReports.clear();
          break;
        }
        graphReports.set(derived.value, Object.freeze({ ...registration }));
      }
    }
  }

  function persistGraphReports(
    next: ReadonlyMap<string, GraphReportCallbackRegistration>,
  ): "durable" | "visible" | "unchanged" {
    if (graphReportStore === undefined) return "durable";
    if (!graphReportStoreAvailable) return "unchanged";
    const records = Array.from(next.values()).sort((left, right) =>
      canonicalGraphReportIdentity(left).localeCompare(canonicalGraphReportIdentity(right))
    );
    const replaced = graphReportStore.replace(records);
    return replaced.ok ? "durable" : replaced.error.snapshot;
  }

  function adoptGraphReports(next: ReadonlyMap<string, GraphReportCallbackRegistration>): void {
    graphReports.clear();
    for (const [key, value] of next) graphReports.set(key, value);
  }

  function render(
    choice: "approve" | "deny" | "details",
    shortId: string,
  ): Result<string, CallbackRenderError> {
    // Delegate to the core/security primitive — single signing implementation.
    return renderCallbackData(getSecret(), choice as CallbackChoice, shortId);
  }

  function registerGraphReport(
    registration: GraphReportCallbackRegistration,
  ): Result<string, GraphReportRegistrationError> {
    if (!graphReportOwnerIsValid(registration)) {
      return err({ kind: "invalid_owner" });
    }
    if (!Number.isSafeInteger(registration.expiresAt) || registration.expiresAt <= clock.now()) {
      return err({ kind: "expired" });
    }

    if (!graphReportStoreAvailable) return err({ kind: "unavailable" });
    const nextReports = new Map(graphReports);
    for (const [shortId, report] of nextReports) {
      if (report.expiresAt <= clock.now()) nextReports.delete(shortId);
    }
    const secret = tryCatch(() => getSecret());
    if (!secret.ok) return err({ kind: "unavailable" });
    const derived = graphReportShortId(secret.value, registration);
    if (!derived.ok || !SHORT_ID_RE.test(derived.value)) {
      return err({ kind: "unavailable" });
    }
    const shortId = derived.value;
    const existing = nextReports.get(shortId);
    if (
      gate.getRequestByShortId(shortId) !== undefined
      || (existing !== undefined && !sameGraphReportIdentity(existing, registration))
    ) {
      return err({ kind: "collision" });
    }
    if (existing === undefined && nextReports.size >= MAX_GRAPH_REPORT_TARGETS) {
      return err({ kind: "capacity" });
    }
    const rendered = renderCallbackData(secret.value, "details", shortId);
    if (!rendered.ok) return err({ kind: "unavailable" });
    nextReports.set(shortId, Object.freeze({ ...registration }));
    const persistence = persistGraphReports(nextReports);
    if (persistence === "visible") adoptGraphReports(nextReports);
    if (persistence !== "durable") return err({ kind: "unavailable" });
    adoptGraphReports(nextReports);
    return ok(rendered.value);
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
    if (inboundUserId === undefined) return { kind: "unknown" };
    const approvedBy = inboundUserId;
    gate.resolveApproval(requestId, choice === "approve", approvedBy);
    return { kind: "resolved", requestId, choice };
  }

  function routeSigned(inbound: InboundCallback): CallbackResolution {
    // ORDER IS LOAD-BEARING. Do NOT reorder.
    // 1. Strict parse of the signed wire format.
    const parsed = parseCallbackData(inbound.rawData);
    if (!parsed.ok) return { kind: "malformed" };
    const { choice, shortId, hmac } = parsed.value;

    // 2. Look up the shortId in the server-side target tables FIRST. Neither an
    //    approval request id nor a graph id is accepted from the wire.
    const req = gate.getRequestByShortId(shortId);
    const graphReport = graphReports.get(shortId);
    // A later approval mint could collide with an existing graph target. The
    // cryptographic id space makes that vanishingly unlikely, but ambiguity must
    // still fail closed instead of choosing either privileged action.
    if (req !== undefined && graphReport !== undefined) return { kind: "unknown" };
    if (req === undefined) {
      const report = graphReport;
      if (report === undefined) return { kind: "unknown" };
      if (!graphReportIsOwnedByInbound(report, inbound)) return { kind: "unknown" };
      if (clock.now() >= report.expiresAt) {
        const nextReports = new Map(graphReports);
        nextReports.delete(shortId);
        const persistence = persistGraphReports(nextReports);
        if (persistence !== "unchanged") adoptGraphReports(nextReports);
        return { kind: "expired" };
      }
      if (!verifyCallbackData(getSecret(), choice, shortId, hmac)) {
        return { kind: "invalid_signature" };
      }
      if (choice !== "details") return { kind: "unknown" };
      const nextReports = new Map(graphReports);
      nextReports.delete(shortId);
      const persistence = persistGraphReports(nextReports);
      if (persistence === "visible") adoptGraphReports(nextReports);
      if (persistence !== "durable") return { kind: "unknown" };
      adoptGraphReports(nextReports);
      return { kind: "graph_report_requested", graphId: report.graphId };
    }

    // 3. Cross-principal guard: one room or agent cannot act on another's
    //    approval. Both inbound fields are orchestrator-derived, never from the wire.
    if (!approvalRequestIsOwnedByInbound(req, inbound)) return { kind: "unknown" };

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
    // and session + agent scoping still applies before disambiguation.
    const command = parsePlainText(inbound.rawData);
    if (command === null) return { kind: "unknown" };

    const { verb, shortIdSuffix } = command;
    const pend = gate.pendingForSession(inbound.sessionKey)
      .filter((request) => approvalRequestIsOwnedByInbound(request, inbound));

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

  return { render, registerGraphReport, route };
}
