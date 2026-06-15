// SPDX-License-Identifier: Apache-2.0
/**
 * Failure-detector tool metadata (§16.10/§16.11).
 *
 * Extracted from `tool-metadata-registry.ts` to keep that file under the
 * 800-line cap (the v2.22/v2.23 closures-extraction protocol — never an
 * allowlist entry). Behavior-neutral: `registerFailureDetectorMetadata()` is
 * called once from `registerAllToolMetadata()` and registers the identical
 * web_search / web_fetch `failureDetector` metadata via spread-merge onto the
 * existing entries (the unique-tool count is unchanged).
 *
 * Pure, synchronous predicates consulted in pi-event-bridge.ts BEFORE the
 * tool:executed emit, over the RAW result (the only site that sees it).
 * They flag a logically-failed result the SDK reported as success
 * (isError:false) — e.g. web_search/web_fetch that returned a real failure
 * payload alongside a 200.
 *
 * They inspect ONLY the tool's STRUCTURED failure fields — NEVER the fetched
 * body — so legitimate page DATA cannot mis-flag a successful result:
 *   - web_fetch: classify off `error` (a string set only on real failures) and
 *     numeric `status` (>= 400). Never read `result.text`/body. This is the fix
 *     for production session 678314278, where a 200 Yahoo Finance fetch was
 *     mis-flagged `dependency` because IBM's share price "403.92999267578"
 *     contains the substring "403" — a body-substring scan over `/403/` matched
 *     legitimate content, then the tool-retry-breaker told the model to stop
 *     retrying web_fetch.
 *   - web_search: classify off the structured failure fields `error` (a stable
 *     machine code: invalid_provider / invalid_freshness / all_providers_failed),
 *     `message`, and `failures` (joined). web_search has no numeric `status`. The
 *     human-readable reason lives in message+failures, NOT the per-result snippets,
 *     which are never read — so a success snippet containing "rate limit" is safe.
 *
 * MUST NOT throw (object-narrowing guards prevent property-access throws; the
 * regexes only ever run over short structured strings, never untrusted bodies) and
 * MUST return a canonical ErrorKind member (resource/timeout/dependency/…). The
 * internal heuristic kinds used elsewhere in the bridge are NOT valid here — only
 * the closed 10-member ErrorKind union. When isError is already set the SDK flagged
 * it, so the detector defers (returns false — no double-flag). exec's non-zero
 * exitCode is already handled upstream in the bridge, so there is no exec detector
 * here. Spread-merge attaches these to the EXISTING web_search/web_fetch entries —
 * the 51-tool unique count is unchanged.
 *
 * @module
 */

import { registerToolMetadata } from "@comis/core";
import type { ErrorKind } from "@comis/core";

/** Register the web_search / web_fetch failure-detector metadata. */
export function registerFailureDetectorMetadata(): void {
  registerToolMetadata("web_search", {
    failureDetector: (result, isError) => {
      if (isError) return false; // SDK already flagged it — defer.
      if (result === null || typeof result !== "object") return false;
      const r = result as { error?: unknown; message?: unknown; failures?: unknown };
      // A real web_search failure is signalled by a top-level `error` MACHINE CODE
      // (invalid_provider / invalid_freshness / all_providers_failed). A SUCCESS payload
      // carries `results` but NO top-level `error` — so a success whose snippet contains
      // "rate limit"/"blocked" returns false here (never reads result.results[].snippet).
      if (typeof r.error !== "string") return false;
      // Build the classification text from the STRUCTURED failure fields only — the machine
      // code plus the human-readable `message` and joined `failures` reasons — NEVER the body.
      const failures = Array.isArray(r.failures)
        ? r.failures.filter((f): f is string => typeof f === "string").join(" ")
        : "";
      const text = `${r.error} ${typeof r.message === "string" ? r.message : ""} ${failures}`;
      if (/rate limit|quota exceeded|too many requests/i.test(text)) {
        // Attribute the verdict to the human-readable `message` field (the rate-limit
        // reason lives there + in `failures`, never in the stable `error` code) and report
        // the LITERAL rule that matched — a fixed description, not a serialized RegExp.
        return {
          errorKind: "resource" satisfies ErrorKind,
          classifiedField: "message",
          matchedRule: "/rate limit|quota exceeded|too many requests/",
        };
      }
      // blocked/forbidden/provider-error set, broadened to the failures-chain reasons.
      // A genuine top-level error with an unrecognised reason is still a real failure →
      // default to dependency (never false once `error` is present). Attributed to the
      // top-level `error` machine code; no matchedRule/matchedToken (this is the catch-all).
      return { errorKind: "dependency" satisfies ErrorKind, classifiedField: "error" };
    },
  });

  registerToolMetadata("web_fetch", {
    failureDetector: (result, isError) => {
      if (isError) return false; // SDK already flagged it — defer.
      if (result === null || typeof result !== "object") return false;
      const r = result as { error?: unknown; status?: unknown };
      // Classify off the structured failure fields ONLY. A SUCCESS result has a numeric
      // `status` 200 and NO `error` key — its body lives in `r.text` and may contain "403"
      // (e.g. the IBM share price 403.92999267578 — production session 678314278), "blocked",
      // "timeout" etc. as legitimate DATA. We never read `r.text`/body, so those don't flag.
      if (typeof r.error === "string") {
        // Timeout text lives in the descriptive error string ("Fetch failed: …timed out…").
        // Attribute to the `error` field + the literal timeout rule.
        if (/\btimed out\b|\btimeout\b/i.test(r.error)) {
          return {
            errorKind: "timeout" satisfies ErrorKind,
            classifiedField: "error",
            matchedRule: "/timed out|timeout/",
          };
        }
        // Catch-all once `error` is set and the timeout rule did not match — attributed to
        // the `error` field, no matchedRule/matchedToken.
        return { errorKind: "dependency" satisfies ErrorKind, classifiedField: "error" };
      }
      if (typeof r.status === "number" && r.status >= 400) {
        // No `error` key → the numeric HTTP `status` drives the verdict; the concrete code
        // is the matched token. Gateway-timeout (504) / request-timeout (408) map to timeout.
        if (r.status === 408 || r.status === 504) {
          return {
            errorKind: "timeout" satisfies ErrorKind,
            classifiedField: "status",
            matchedToken: String(r.status),
          };
        }
        return {
          errorKind: "dependency" satisfies ErrorKind,
          classifiedField: "status",
          matchedToken: String(r.status),
        };
      }
      return false;
    },
  });
}
