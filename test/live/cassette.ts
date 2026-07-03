// SPDX-License-Identifier: Apache-2.0
/**
 * Two-speed replay/record seam — record, replay, diff, secret-swept.
 *
 * Implements the cassette layer:
 *   - Record at the provider-adapter boundary (post-SDK, not HTTP layer)
 *   - Strip Authorization headers before write
 *   - Run assertNoSecrets on the serialized line before appendFileSync
 *   - Replay deterministically from NDJSON (no real provider call)
 *   - Diff two cassette files to surface PROVIDER_DRIFT alerts
 *
 * Default storage:
 *   test/live/cassettes/<provider>/<scenarioId>/<modelSnapshot>.jsonl
 *   (git-ignored — regenerate locally)
 *
 * @module
 */
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { assertNoSecrets } from "./cost.js";

/**
 * A single round-trip captured at the provider-adapter boundary.
 *
 * One NDJSON line per record; the fields below define the format.
 */
export interface CassetteRecord {
  /** ISO-8601 timestamp of the capture. */
  ts: string;
  /** Scenario identifier — used for replay lookup and diff matching. */
  scenarioId: string;
  /** Pinned model snapshot ID (e.g. "claude-3-5-haiku-20241022"). */
  modelSnapshot: string;
  /** Provider name (e.g. "anthropic", "openai"). */
  provider: string;
  /** SDK request payload sent to the provider. */
  request: Record<string, unknown>;
  /** SDK response payload received from the provider. */
  response: Record<string, unknown>;
  /** system_fingerprint from OpenAI-compatible responses; FINGERPRINT_CHANGE alert on change. */
  systemFingerprint?: string;
}

/** A drift alert emitted when a response field differs between two cassettes. */
export interface DriftAlert {
  /** Scenario that drifted. */
  scenarioId: string;
  /** Names of response fields that changed between cassette A and cassette B. */
  changedFields: string[];
}

/**
 * Strip Authorization headers from a cassette record before serialization.
 *
 * Operates on a shallow copy — does not mutate the input record.
 * First guard against credential leakage in cassette files.
 */
function stripAuthHeaders(record: CassetteRecord): CassetteRecord {
  const req = { ...record.request };
  const headersKey = Object.keys(req).find(
    (k) => k.toLowerCase() === "headers",
  );
  if (headersKey !== undefined && typeof req[headersKey] === "object" && req[headersKey] !== null) {
    const headers = { ...(req[headersKey] as Record<string, unknown>) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") {
        headers[key] = "[STRIPPED]";
      }
    }
    req[headersKey] = headers;
  }
  return { ...record, request: req };
}

/**
 * Record a cassette entry to a NDJSON file.
 *
 * Security protocol (double guard):
 *   1. assertNoSecrets on raw serialized record — catches any secret in any field
 *      before any processing (including in Authorization header values). Throws
 *      if the raw record contains credential-shaped patterns.
 *   2. stripAuthHeaders — removes Authorization headers from the record to write.
 *      Even after assertNoSecrets passes, credentials must not appear in the file.
 *
 * The two guards serve complementary purposes:
 *   - Guard 1 (raw assertNoSecrets) ensures we never silently sanitize a leaked secret.
 *   - Guard 2 (stripAuthHeaders) ensures Authorization tokens are removed even when
 *     they don't match the secret pattern (e.g. internal tokens, opaque strings).
 *
 * Throws if any secret-shaped pattern is detected (never writes the offending line).
 *
 * @param filePath - destination NDJSON file (created if absent, appended if existing)
 * @param record   - the round-trip record to append
 */
export function recordCassette(filePath: string, record: CassetteRecord): void {
  // Guard 1 — scan the raw (pre-strip) serialized line for secrets.
  // Throws before any write or stripping if a credential pattern is present.
  const rawLine = JSON.stringify(record);
  assertNoSecrets(rawLine, `cassette record for ${record.scenarioId}`);

  // Guard 2 — strip Authorization headers before writing.
  const stripped = stripAuthHeaders(record);
  const line = JSON.stringify(stripped);
  appendFileSync(filePath, line + "\n", "utf-8");
}

/**
 * Replay cassette records matching a given scenarioId from a NDJSON file.
 *
 * Returns an empty array when the file does not exist (no throw).
 * Malformed lines are silently skipped (try/catch).
 *
 * @param filePath   - source NDJSON cassette file
 * @param scenarioId - scenario to match; pass "" to get all records
 */
export function replayCassette(
  filePath: string,
  scenarioId: string,
): CassetteRecord[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const records: CassetteRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CassetteRecord;
      if (scenarioId === "" || parsed.scenarioId === scenarioId) {
        records.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/**
 * Compare two cassette files and return drift alerts for any scenario whose
 * response fields differ between file A and file B.
 *
 * Matching is performed by (scenarioId × modelSnapshot). Only response-field
 * differences are reported — field *names* are logged, never field values
 * (the PROVIDER_DRIFT alert omits values).
 *
 * Returns an empty array when either file is absent.
 *
 * @param pathA - reference cassette (e.g. the on-disk committed/cached cassette)
 * @param pathB - new cassette (e.g. re-recorded in the current live run)
 */
export function diffCassette(pathA: string, pathB: string): DriftAlert[] {
  if (!existsSync(pathA) || !existsSync(pathB)) return [];

  const allA = replayCassette(pathA, "");
  const allB = replayCassette(pathB, "");

  const alerts: DriftAlert[] = [];

  for (const recA of allA) {
    const recB = allB.find(
      (r) =>
        r.scenarioId === recA.scenarioId &&
        r.modelSnapshot === recA.modelSnapshot,
    );
    if (!recB) continue;

    const changedFields: string[] = [];
    for (const key of Object.keys(recA.response)) {
      if (
        JSON.stringify(recA.response[key]) !==
        JSON.stringify((recB.response as Record<string, unknown>)[key])
      ) {
        changedFields.push(key);
      }
    }
    if (changedFields.length > 0) {
      // emit field names only, never field values
      alerts.push({ scenarioId: recA.scenarioId, changedFields });
    }
  }

  return alerts;
}
