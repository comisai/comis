// SPDX-License-Identifier: Apache-2.0
/**
 * The send-path guards for `terminal_session_send_text` / `_send_key` PLUS the
 * resize geometry validator ({@link readDimension})
 * — extracted from `terminal-tools.ts` so that file stays under the 800-line
 * architecture cap (the same discipline that produced
 * `terminal-worker-launch.ts` / `terminal-workspace.ts` / `terminal-reaper.ts`).
 *
 * The two send tools call {@link enforceSendCapsThenAudit} (which composes the two
 * primitives below in the canonical order — enforce caps, then audit EVERY invocation
 * tagged with its outcome, INCLUDING a cap-rejected one) BEFORE
 * forwarding to the registry:
 *
 *   1. {@link enforceSendCaps} — the binding EVICT-vs-REJECT cap split:
 *      - `maxRequestsPerSession` (rate cap) → REJECT only; the session
 *        SURVIVES (read/list/other sends still work).
 *      - `maxInteractions` (interaction budget spent) → EVICT via
 *        `registry.evict(sessionId, owner, "max_interactions")` (the single audited
 *        eviction path: drop + workspace cleanup + `terminal:session_evicted` + the
 *        registry `onCapForget` → `caps.forget`) THEN reject.
 *      - `wallClockMs` → EVICT likewise (reason `wall_clock`) THEN reject;
 *        the reaper sweep also evicts on age — this is the immediate per-send guard
 *        routing through the SAME eviction path.
 *      The tool does NOT call `caps.forget` in the evict branches — the registry's
 *      `onCapForget` owns that (no double-forget).
 *
 *   2. {@link auditKeystroke} — the per-send keystroke audit: scrub the raw payload via
 *      `scrubSecretsFromText` (the @comis/core primitive the read tool uses — NEVER
 *      `redactSecretsInText`, which is the skills-forbidden @comis/observability),
 *      put the REDACTED payload in the structured LOG (DEBUG, step `keystroke_audit`),
 *      and emit the `terminal:keystroke` bus event carrying ONLY the redaction-safe
 *      summary (`redactions` + `byteLength`; never the payload). The raw payload NEVER
 *      reaches a log or the bus.
 *
 * The guards take a NARROW structural `SendGuardDeps` (the exact subset of
 * `TerminalToolDeps` they use), defined HERE rather than importing `TerminalToolDeps`
 * from `terminal-tools.ts` — that inverts the dependency so there is NO
 * `terminal-tools ↔ terminal-send-guards` import cycle (madge counts type-only edges).
 * `TerminalToolDeps` is a structural superset, so the tools pass `deps` verbatim.
 *
 * Architecture: this is daemon-side `@comis/skills` code — it value-imports only
 * `@comis/core` (`scrubSecretsFromText`) + the local `tool-helpers` (`throwToolError`)
 * and TYPE-ONLY the leaf registry/caps shapes; NEVER `@comis/infra`/`@comis/observability`.
 *
 * @module
 */

import { scrubSecretsFromText } from "@comis/core";

import { throwToolError } from "../../../platform-tools/tool-helpers.js";
import type { SessionCaps } from "./terminal-caps.js";
import type { SessionOwner, TerminalSessionRegistry } from "./terminal-session-registry.js";
import type { EvictReason } from "./terminal-reaper.js";

/** The redaction-safe keystroke-audit event payload (mirrors core `terminal:keystroke`). */
interface KeystrokeAuditEvent {
  sessionId: string;
  agentId: string;
  kind: "text" | "key";
  redactions: number;
  byteLength: number;
  /** Attempt outcome: `attempted` = forwarded; `rejected` = blocked by a cap breach. */
  outcome: "attempted" | "rejected";
  timestamp: number;
}

/**
 * The NARROW deps the send guards use — a structural subset of `TerminalToolDeps`
 * (defined here, NOT imported, to keep the dependency one-directional / cycle-free).
 * The registry surface is narrowed to just `evict` (the only method the guards drive).
 */
export interface SendGuardDeps {
  readonly caps: SessionCaps;
  readonly registry: Pick<TerminalSessionRegistry, "evict">;
  readonly logger: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly eventBus: { emit(event: "terminal:keystroke", payload: KeystrokeAuditEvent): unknown };
  readonly agentId: string;
  readonly nowMs: () => number;
}

/**
 * Enforce the per-session caps BEFORE forwarding a `send_*` to the registry — throws
 * `permission_denied` on ANY breach (never returns on breach). See the module doc for
 * the EVICT-vs-REJECT split. Every breach WARNs with `errorKind: "resource"` +
 * `step: "cap_breach"` (§2.7).
 */
export async function enforceSendCaps(
  deps: SendGuardDeps,
  sessionId: string,
  owner: SessionOwner,
  toolName: string,
): Promise<void> {
  const reqBreach = deps.caps.consumeRequest(sessionId);
  if (reqBreach) {
    deps.logger.warn(
      { toolName, sessionId, errorKind: "resource" as const, step: "cap_breach", hint: "per-session request rate cap reached" },
      "terminal session request cap exceeded",
    );
    throwToolError("permission_denied", `cap exceeded: ${reqBreach.breach}`, {
      hint: "this session reached its per-session request rate cap (operator limits.maxRequestsPerSession) — the session stays usable for read/list/other sends",
    });
  }

  const intBreach = deps.caps.consumeInteraction(sessionId);
  if (intBreach) {
    deps.logger.warn(
      { toolName, sessionId, errorKind: "resource" as const, step: "cap_breach", hint: "interaction budget spent — evicting" },
      "terminal session interaction budget exceeded",
    );
    // EVICT (not just reject) — the interaction budget is spent. The registry path drops
    // + cleans + emits + onCapForget; do NOT also call caps.forget here (no double-forget).
    await deps.registry.evict(sessionId, owner, "max_interactions" satisfies EvictReason);
    throwToolError("permission_denied", "cap exceeded: max_interactions", {
      hint: "this session spent its interaction budget (operator limits.maxInteractions) and was evicted",
    });
  }

  const wcBreach = deps.caps.checkWallClock(sessionId);
  if (wcBreach) {
    deps.logger.warn(
      { toolName, sessionId, errorKind: "resource" as const, step: "cap_breach", hint: "wall-clock budget exceeded — evicting" },
      "terminal session wall-clock budget exceeded",
    );
    await deps.registry.evict(sessionId, owner, "wall_clock" satisfies EvictReason);
    throwToolError("permission_denied", "cap exceeded: wall_clock", {
      hint: "this session exceeded its wall-clock budget (operator limits.wallClockMs) and was evicted",
    });
  }
}

/**
 * Emit the keystroke audit for one `send_*` INVOCATION. See the module doc.
 * The raw `payload` NEVER reaches a log or the bus — only the scrubbed payload (LOG)
 * and the redaction-safe summary (EVENT). `outcome` tags the attempt: `attempted`
 * (passed the caps, forwarded) or `rejected` (a cap breach blocked the forward) —
 * an ATTEMPT signal, never proof of delivery (the event doc spells this out).
 */
export function auditKeystroke(
  deps: SendGuardDeps,
  sessionId: string,
  toolName: string,
  kind: "text" | "key",
  payload: string,
  outcome: "attempted" | "rejected",
): void {
  const { text: redactedText, redactions } = scrubSecretsFromText(payload);
  // DEBUG (not INFO): the keystroke audit is a step-tagged intermediate-stage record;
  // the send completion INFO line (with durationMs) stays the one INFO per send. Keeping
  // the audit at DEBUG also avoids shadowing that completion line for log consumers.
  deps.logger.debug(
    { toolName, sessionId, redactedText, redactions, outcome, step: "keystroke_audit" },
    "terminal keystroke",
  );
  deps.eventBus.emit("terminal:keystroke", {
    sessionId,
    agentId: deps.agentId,
    kind,
    redactions,
    byteLength: Buffer.byteLength(redactedText),
    outcome,
    timestamp: deps.nowMs(),
  });
}

/**
 * Enforce the per-session caps THEN audit the send — the single canonical order
 * the two send tools call. EVERY invocation is audited exactly once:
 *   - a cap breach → audit `outcome:"rejected"` (the redacted attempt is still
 *     recorded — what the agent TRIED to type before it was rate-capped/evicted),
 *     then the `enforceSendCaps` rejection re-propagates (the forward is skipped);
 *   - no breach → audit `outcome:"attempted"`, then the caller forwards to the
 *     registry.
 * Auditing on the breach path is safe: `auditKeystroke` only LOGs the redacted form
 * + emits the redaction-safe summary — it writes nothing to the PTY. Centralizing the
 * try/audit/rethrow here (vs inlining it in both tools) keeps terminal-tools.ts lean.
 */
export async function enforceSendCapsThenAudit(
  deps: SendGuardDeps,
  sessionId: string,
  owner: SessionOwner,
  toolName: string,
  kind: "text" | "key",
  payload: string,
): Promise<void> {
  try {
    await enforceSendCaps(deps, sessionId, owner, toolName);
  } catch (err) {
    // A capped/evicted send is STILL audited (tagged rejected) before the
    // typed permission_denied propagates — the attempt must not vanish from the trail.
    auditKeystroke(deps, sessionId, toolName, kind, payload, "rejected");
    // @allow-throw: re-propagate the enforceSendCaps rejection after recording the
    // keystroke audit; the forward is intentionally skipped on a cap breach.
    throw err;
  }
  auditKeystroke(deps, sessionId, toolName, kind, payload, "attempted");
}

/**
 * The upper bound on a terminal dimension. A real terminal is never this
 * wide/tall; the cap blocks an agent from inflating the worker's emulator buffer /
 * PTY winsize with an absurd value. The schema types cols/rows as integers; this is
 * the value-range guard the schema does not express.
 */
export const MAX_TERMINAL_DIMENSION = 10_000;

/**
 * Read + VALIDATE a terminal dimension (cols/rows) from agent params. The
 * geometry is not a trust boundary, but the tool layer must not forward a degenerate
 * value (0/negative/non-integer/absurd) into the worker's `Terminal({cols,rows})` /
 * PTY winsize. Throws a typed `invalid_value` (never returns on a bad value) so the
 * resize tool rejects BEFORE the registry forward. Lives here (not terminal-tools.ts)
 * to keep that file under the 800-line architecture cap.
 */
export function readDimension(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TERMINAL_DIMENSION) {
    throwToolError("invalid_value", `Invalid ${key}: must be an integer in 1..${MAX_TERMINAL_DIMENSION}.`, {
      param: key,
      hint: `pass a positive ${key} no larger than ${MAX_TERMINAL_DIMENSION}`,
    });
  }
  return v;
}
