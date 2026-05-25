// SPDX-License-Identifier: Apache-2.0
/**
 * `emitSerializationErrorSentinel` — last-resort writer for the config-audit
 * JSONL line when re-encoding fails. Sentinel is hand-crafted from only
 * string + number literals so JSON.stringify CANNOT return undefined.
 *
 * Used by append.ts, scrub.ts, append-observe.ts. Consolidated from 3
 * byte-identical copies (config-audit serialization invariant).
 *
 * @module
 */
import { systemDateFrom, systemNowMs } from "@comis/core";

export function emitSerializationErrorSentinel(): string {
  const sentinel = {
    traceSchema: "comis-config-audit" as const,
    schemaVersion: 1 as const,
    __serializationError: "record-not-serializable" as const,
    ts: systemDateFrom(systemNowMs()).toISOString(),
  };
  // Sentinel is hand-crafted from string + number literals — JSON.stringify
  // cannot return undefined here. The `?? ""` is a belt-and-braces fallback
  // for the type system; if it ever fires, the test in
  // serialization-sentinel.test.ts will go red.
  return (JSON.stringify(sentinel) ?? "") + "\n";
}
