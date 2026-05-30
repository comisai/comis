// SPDX-License-Identifier: Apache-2.0
/**
 * Typed emit helpers for the broker:* event taxonomy.
 *
 * Each function builds a redaction-safe event payload and calls bus.emit()
 * once. Call sites in mitm-broker.ts become one-liners. Security invariant:
 * emitEgressBlocked hashes the host with SHA-256 — the plaintext host value
 * NEVER appears in the emitted payload (OBS-01 redaction-by-construction).
 *
 * No Date.now() — all timestamps are supplied by the caller (deps.clock.now()).
 *
 * @module
 */
import { createHash } from "node:crypto";
import type { InjectionRule, TypedEventBus } from "@comis/core";

/**
 * Emits broker:session_opened when a CONNECT tunnel is established.
 * The caller supplies the timestamp from deps.clock.now().
 */
export function emitSessionOpened(
  bus: TypedEventBus,
  payload: {
    sessionId: string;
    agentId: string;
    host: string;
    presetId?: string;
    timestamp: number;
  },
): void {
  bus.emit("broker:session_opened", payload);
}

/**
 * Emits broker:session_closed when a tunnel is torn down.
 * durationMs must be computed by the caller as (clock.now() - sessionStartedAt).
 */
export function emitSessionClosed(
  bus: TypedEventBus,
  payload: {
    sessionId: string;
    agentId: string;
    durationMs: number;
    reason: "teardown" | "error" | "expired";
    timestamp: number;
  },
): void {
  bus.emit("broker:session_closed", payload);
}

/**
 * Emits broker:request when a proxied HTTP request is received inside the tunnel.
 * path must be the raw request path (pre-injection) — never include query secrets.
 */
export function emitRequest(
  bus: TypedEventBus,
  payload: {
    sessionId: string;
    host: string;
    path: string;
    method: string;
    timestamp: number;
  },
): void {
  bus.emit("broker:request", payload);
}

/**
 * Emits broker:injected after credential injection completes.
 * Carries ruleKind only — never the secret value.
 */
export function emitInjected(
  bus: TypedEventBus,
  payload: {
    sessionId: string;
    host: string;
    ruleKind: InjectionRule["kind"];
    timestamp: number;
  },
): void {
  bus.emit("broker:injected", payload);
}

/**
 * Emits broker:denied when a request is rejected at any gate.
 * reason is a closed union matching the event taxonomy.
 */
export function emitDenied(
  bus: TypedEventBus,
  payload: {
    sessionId: string;
    host: string;
    reason:
      | "no_binding"
      | "bad_token"
      | "path_policy"
      | "unknown_host"
      | "malformed_request"
      | "body_too_large"
      | "ws_upgrade_not_supported";
    statusCode: number;
    timestamp: number;
  },
): void {
  bus.emit("broker:denied", payload);
}

/**
 * Emits broker:credential_unavailable when SecretManager returns undefined
 * for a binding's secretRef. secretRef is the key name only — never the value.
 */
export function emitCredentialUnavailable(
  bus: TypedEventBus,
  payload: {
    sessionId: string;
    secretRef: string;
    agentId: string;
    timestamp: number;
  },
): void {
  bus.emit("broker:credential_unavailable", payload);
}

/**
 * Emits broker:egress_blocked when an egress attempt is made to a non-broker host.
 *
 * Security invariant (T-06-01 / OBS-01): the plaintext host value is NEVER
 * passed to bus.emit. Instead, a SHA-256 hex digest is computed here and only
 * the hash reaches the event payload. This is enforced structurally — there is
 * no way for a caller to bypass the hash step.
 */
export function emitEgressBlocked(
  bus: TypedEventBus,
  { sessionId, host, timestamp }: { sessionId: string; host: string; timestamp: number },
): void {
  const targetHostHash = createHash("sha256").update(host, "utf8").digest("hex");
  bus.emit("broker:egress_blocked", { sessionId, targetHostHash, timestamp });
}
