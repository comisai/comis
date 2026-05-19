// SPDX-License-Identifier: Apache-2.0
/**
 * persistSystemPromptReport — double-write persister with sanitize
 * pipeline.
 *
 * Per design §8.3 the persistence path writes the assembled report
 * to:
 *   - the observability store (SQLite `system_prompt_reports` table)
 *   - optionally a session-level sink (so the report rides alongside
 *     other per-session diagnostics)
 *
 * The function:
 *   - Sanitizes the report via `sanitizeForPersistence` (the 45-02
 *     pipeline: limitPayloadValue + sanitizeDiagnosticPayload +
 *     redactSecrets) BEFORE the INSERT.
 *   - JSON.stringify's the sanitized report into `report_json`.
 *   - Returns `Result<void, PersistError>` per AGENTS.md §2.1 — never
 *     throws. Store errors degrade silently per research §4.1.
 *
 * The `ObservabilityStore` interface is imported as a TYPE only from
 * `@comis/memory`. The narrow Pick<> shape decouples this module from
 * the full memory contract — only `insertSystemPromptReport` is read.
 * TypeScript erases type imports at runtime, so the dep direction is
 * preserved at the JS emit level.
 *
 * `SessionStoreReportSink` is a soft port (not part of
 * `SessionStorePort`) — consumers wishing to write the report into a
 * session ledger implement this small interface. The agent / daemon
 * wiring decides whether to inject a real sink or omit.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import type { SystemPromptReport } from "./types.js";

/**
 * Narrow Pick of `@comis/memory#ObservabilityStore` — only the one
 * method this module calls. Keeps the dependency surface minimal and
 * type-only.
 */
export interface ObservabilityStoreLike {
  insertSystemPromptReport(row: {
    agentId: string;
    tenantId: string | null;
    sessionId: string;
    runId: string | null;
    generatedAt: number;
    provider: string | null;
    model: string | null;
    systemChars: number;
    systemSha256: string;
    reportJson: string;
  }): void;
}

/**
 * Soft port for session-level report persistence. NOT part of
 * `SessionStorePort` — consumers that want the per-session sink
 * implement this small contract themselves and inject it into
 * `persistSystemPromptReport`.
 */
export interface SessionStoreReportSink {
  writeSystemPromptReport(input: {
    sessionId: string;
    report: SystemPromptReport;
  }): void | Promise<void>;
}

/** Single-error type for the persistence Result. */
export interface PersistError {
  readonly kind: "observability-store" | "session-store" | "both";
  readonly errors: ReadonlyArray<Error>;
}

export interface PersistDeps {
  observabilityStore?: ObservabilityStoreLike;
  sessionStore?: SessionStoreReportSink;
  logger?: ComisLogger;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Persist a SystemPromptReport via the configured sinks.
 *
 * - Sanitizes the report via the 45-02 pipeline.
 * - Best-effort dual write: failures of one sink do not abort the
 *   other. Errors are collected and reported via `Result.err`.
 *
 * @param report - the assembled SystemPromptReport (pre-sanitization)
 * @param deps   - the sink injection point + optional logger
 * @returns Result<void, PersistError>
 */
export async function persistSystemPromptReport(
  report: SystemPromptReport,
  deps: PersistDeps,
): Promise<Result<void, PersistError>> {
  const { observabilityStore, sessionStore, logger } = deps;

  // 1. Sanitize — strip credential-shaped fields, mask in-text
  //    credential bodies, bound payload size/depth. Same pipeline as
  //    trajectory + (future) config-audit writers.
  //
  // NB: the sanitizer treats `sessionId` (and other "session_id"-shaped
  // names) as credential-keyed and masks the VALUE. That's the right
  // call for free-form diagnostic payloads, but the SystemPromptReport
  // shape uses sessionId/agentId as PRIMARY-KEY columns in the
  // `system_prompt_reports` table — they MUST flow through as plain
  // strings into the SQLite row. Capture those keys from the ORIGINAL
  // report (pre-sanitization) and use the sanitized graph only for the
  // `report_json` payload that gets serialized.
  const keys = {
    agentId: report.agentId,
    tenantId: report.tenantId ?? null,
    sessionId: report.sessionId,
    runId: report.runId ?? null,
    generatedAt: report.generatedAt,
    provider: report.provider ?? null,
    model: report.model ?? null,
    systemChars: report.systemPrompt.chars,
    systemSha256: report.systemPrompt.sha256,
  };
  const safeReport = sanitizeForPersistence(report) as SystemPromptReport;

  const errors: Error[] = [];

  // 2. observability-store write (best-effort).
  if (observabilityStore) {
    try {
      const reportJson = JSON.stringify(safeReport);
      observabilityStore.insertSystemPromptReport({
        ...keys,
        reportJson,
      });
    } catch (e) {
      const obsErr = toError(e);
      errors.push(obsErr);
      logger?.warn(
        {
          err: obsErr,
          agentId: keys.agentId,
          sessionId: keys.sessionId,
          hint: "SystemPromptReport observability-store write failed; report not persisted to SQLite",
          errorKind: "dependency" as const,
        },
        "persistSystemPromptReport: observability-store write failed",
      );
    }
  }

  // 3. session-store write (best-effort; runs even if (2) failed).
  if (sessionStore) {
    try {
      await sessionStore.writeSystemPromptReport({
        // sessionId is from the ORIGINAL report — sanitizer would mask
        // the value (see the explanation above the keys object).
        sessionId: keys.sessionId,
        report: safeReport,
      });
    } catch (e) {
      const sessErr = toError(e);
      errors.push(sessErr);
      logger?.warn(
        {
          err: sessErr,
          agentId: keys.agentId,
          sessionId: keys.sessionId,
          hint: "SystemPromptReport session-store write failed; report not persisted to session sink",
          errorKind: "dependency" as const,
        },
        "persistSystemPromptReport: session-store write failed",
      );
    }
  }

  if (errors.length === 0) return ok(undefined);

  const kind: PersistError["kind"] =
    errors.length === 2 ? "both" : observabilityStore && errors[0] ? "observability-store" : "session-store";
  return err({ kind, errors });
}
