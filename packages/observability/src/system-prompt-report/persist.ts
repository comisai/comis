// SPDX-License-Identifier: Apache-2.0
/**
 * persistSystemPromptReport — double-write persister with sanitize
 * pipeline.
 *
 * The persistence path writes the assembled report to:
 *   - the observability store (SQLite `system_prompt_reports` table)
 *   - optionally a session-level sink (so the report rides alongside
 *     other per-session diagnostics)
 *
 * The function:
 *   - Sanitizes the report via `sanitizeForPersistence`
 *     (limitPayloadValue + sanitizeDiagnosticPayload + redactSecrets)
 *     BEFORE the INSERT.
 *   - JSON.stringify's the sanitized report into `report_json`.
 *   - Returns `Result<void, PersistError>` per AGENTS.md §2.1 — never
 *     throws. Store errors degrade silently.
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
 * - Sanitizes the report via the persistence pipeline.
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
  // The sanitizer does not mask
  // `sessionId`/`agentId`/`runId`/`tenantId`/`traceId` — those are
  // structural join keys, not credentials. They flow through
  // `sanitizeForPersistence` intact as plain strings, so the INSERT
  // row can be built directly from `safeReport` without a parallel
  // "captured from the original" key object.
  const safeReport = sanitizeForPersistence(report) as SystemPromptReport;
  const reportJson = JSON.stringify(safeReport);

  const errors: Error[] = [];

  // 2. observability-store write (best-effort).
  if (observabilityStore) {
    try {
      observabilityStore.insertSystemPromptReport({
        agentId: safeReport.agentId,
        tenantId: safeReport.tenantId ?? null,
        sessionId: safeReport.sessionId,
        runId: safeReport.runId ?? null,
        generatedAt: safeReport.generatedAt,
        provider: safeReport.provider ?? null,
        model: safeReport.model ?? null,
        systemChars: safeReport.systemPrompt.chars,
        systemSha256: safeReport.systemPrompt.sha256,
        reportJson,
      });
    } catch (e) {
      const obsErr = toError(e);
      errors.push(obsErr);
      logger?.warn(
        {
          err: obsErr,
          agentId: safeReport.agentId,
          sessionId: safeReport.sessionId,
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
        sessionId: safeReport.sessionId,
        report: safeReport,
      });
    } catch (e) {
      const sessErr = toError(e);
      errors.push(sessErr);
      logger?.warn(
        {
          err: sessErr,
          agentId: safeReport.agentId,
          sessionId: safeReport.sessionId,
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
