// SPDX-License-Identifier: Apache-2.0
/**
 * The send-path guards for `terminal_session_send_text` / `_send_key` (SEC-10,
 * OPS-03, OPS-06) — extracted from `terminal-tools.ts` so that file stays under the
 * 800-line architecture cap (RESEARCH Pitfall 5; the same discipline that produced
 * `terminal-worker-launch.ts` / `terminal-workspace.ts` / `terminal-reaper.ts`).
 *
 * Two pure functions the two send tools call, in order, BEFORE forwarding to the
 * registry:
 *
 *   1. {@link enforceSendCaps} — the binding EVICT-vs-REJECT cap split (123-CONTEXT):
 *      - `maxRequestsPerSession` (OPS-03/R1, rate cap) → REJECT only; the session
 *        SURVIVES (read/list/other sends still work).
 *      - `maxInteractions` (OPS-06, interaction budget spent) → EVICT via
 *        `registry.evict(sessionId, owner, "max_interactions")` (the single audited
 *        eviction path: drop + workspace cleanup + `terminal:session_evicted` + the
 *        registry `onCapForget` → `caps.forget`) THEN reject.
 *      - `wallClockMs` (OPS-06) → EVICT likewise (reason `wall_clock`) THEN reject;
 *        the reaper sweep also evicts on age — this is the immediate per-send guard
 *        routing through the SAME eviction path.
 *      The tool does NOT call `caps.forget` in the evict branches — the registry's
 *      `onCapForget` owns that (no double-forget).
 *
 *   2. {@link auditKeystroke} — the SEC-10 per-send audit: scrub the raw payload via
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
 * Emit the SEC-10 keystroke audit for one `send_*`. See the module doc. The raw
 * `payload` NEVER reaches a log or the bus — only the scrubbed payload (LOG) and the
 * redaction-safe summary (EVENT).
 */
export function auditKeystroke(
  deps: SendGuardDeps,
  sessionId: string,
  toolName: string,
  kind: "text" | "key",
  payload: string,
): void {
  const { text: redactedText, redactions } = scrubSecretsFromText(payload);
  // DEBUG (not INFO): the keystroke audit is a §2.7 step-tagged intermediate-stage record;
  // the send completion INFO line (with durationMs) stays the one INFO per send. Keeping
  // the audit at DEBUG also avoids shadowing that completion line for log consumers.
  deps.logger.debug(
    { toolName, sessionId, redactedText, redactions, step: "keystroke_audit" },
    "terminal keystroke",
  );
  deps.eventBus.emit("terminal:keystroke", {
    sessionId,
    agentId: deps.agentId,
    kind,
    redactions,
    byteLength: Buffer.byteLength(redactedText),
    timestamp: deps.nowMs(),
  });
}
