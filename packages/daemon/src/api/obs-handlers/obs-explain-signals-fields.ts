// SPDX-License-Identifier: Apache-2.0
/**
 * Field readers + redaction helpers for `toIncidentSignals`
 * (`obs-explain-signals.ts`).
 *
 * Defensive reads (every on-disk record is `Record<string, unknown>`) plus the
 * two depth-independent SECURITY projections the normalizer relies on:
 *   - `relativizeDiskPath` — an absolute host path (`/Users/…/.comis/…`) is
 *     collapsed to the workspace-relative tail; the absolute path is never
 *     emitted.
 *   - `previewAndDigest` — `errorPreview` is a bounded, credential-redacted
 *     HEAD slice; the full body is captured only as `resultDigest`. A wrapped
 *     EXTERNAL/untrusted body (whose HEAD carries a prompt-injection marker) is
 *     collapsed WHOLESALE to a digest reference.
 *
 * @module
 */

import { fingerprint, sanitizeLogString } from "@comis/core";
import type { IncidentSignals } from "@comis/core";

/** The reconstructed image-generation turn (the non-optional shape of
 *  `IncidentSignals["image"]`). */
export type IncidentImageSignal = NonNullable<IncidentSignals["image"]>;

/** Hard cap on every `errorPreview` — the long body is never carried whole. */
const MAX_ERROR_PREVIEW = 200;

/** Perf bound: never scan more than 2 KB to produce a ≤200-char preview
 * (sanitizeLogString self-bounds ReDoS at its own 1 MB cap). Slicing the body
 * before sanitize avoids running the credential-regex over a 50 KB body just to
 * keep 200 chars. Generous vs. MAX_ERROR_PREVIEW so the sanitizer still sees
 * enough context to redact. */
const RAW_BODY_SCAN_BOUND = 2_000;

/**
 * Markers that identify an EXTERNAL, UNTRUSTED tool body (the `wrapExternalContent`
 * envelope Comis prepends to web/email/webhook content, which carries a
 * prompt-injection block). When a failure body is wrapped untrusted content, even
 * a 200-char HEAD slice begins with this marker — so the length cap alone leaks
 * the injection header. The preview of such a body is collapsed WHOLESALE to a
 * digest reference; the full body stays addressable via `resultDigest`
 * (T-153-14, depth-independent — the consumer never sees the marker or its
 * directives). Matched on the bounded slice (post-cap), never the raw body.
 */
const UNTRUSTED_CONTENT_MARKER_RE = /SECURITY NOTICE|UNTRUSTED source/i;

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Keep only string entries of an array payload field (non-array → empty).
 * Defensive read for record fields that cross the provider/MCP-influenced
 * trust boundary into admin-facing verdict text (T-175-17). */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Relativize an offload disk path so the absolute host path is never emitted.
 * Absolute host paths (`/Users/…/.comis/…`) collapse to the tail after the
 * last `.comis/`; already-relative pointers pass through; an unrecognizable
 * absolute path collapses to a `<offloaded>` placeholder.
 */
export function relativizeDiskPath(diskPath: string | undefined): string {
  if (diskPath === undefined || diskPath.length === 0) return "<offloaded>";
  const marker = ".comis/";
  const idx = diskPath.lastIndexOf(marker);
  if (idx >= 0) return diskPath.slice(idx + marker.length);
  // Already-relative pointer (no leading slash) is safe to keep verbatim.
  if (!diskPath.startsWith("/")) return diskPath;
  // Absolute path that does not pass through .comis/ — never emit it whole.
  return "<offloaded>";
}

/** Build a redaction-safe, bounded preview + a digest of the full body. */
export function previewAndDigest(errorText: string | undefined): {
  errorPreview: string;
  resultDigest: string;
  resultBytes: number;
} {
  const body = errorText ?? "";
  const resultBytes = Buffer.byteLength(body, "utf8");
  const resultDigest = fingerprint(body);
  // Pre-bound BEFORE sanitize (ReDoS guard on oversized bodies), then redact,
  // then hard-cap at MAX_ERROR_PREVIEW. The full body lives only in the digest.
  const capped = sanitizeLogString(body.slice(0, RAW_BODY_SCAN_BOUND)).slice(
    0,
    MAX_ERROR_PREVIEW,
  );
  // Untrusted-content guard (T-153-14): a wrapped EXTERNAL body leads with the
  // "SECURITY NOTICE" injection marker, so the HEAD slice would inline it.
  // Collapse the preview to a digest reference — the body is still addressable
  // via resultDigest. Depth-independent (this runs before any depth bounding).
  const errorPreview = UNTRUSTED_CONTENT_MARKER_RE.test(capped)
    ? "[redacted:untrusted-content digest:" + resultDigest + "]"
    : capped;
  return { errorPreview, resultDigest, resultBytes };
}

/**
 * OBS-03/OBS-04 (186): fold one `image.*` trajectory record into the
 * reconstructed image-generation turn (extracted from `toIncidentSignals` to
 * keep that module ≤500). Pure: takes the prior image state + the record's
 * `type`/`data` and returns the new state. The terminal `image.generated` /
 * `image.failed` record sets `outcome` (+ cost/model on success, errorKind on
 * failure — the cost rides image.generated, Route a); `image.delivered` flips
 * `delivered`; `image.requested` seeds a conservative `outcome:"failed"` block
 * so a turn aborting before a terminal record still surfaces. Returns `prev`
 * unchanged for a non-image type. Content-free reads (ids/labels/numbers only).
 */
export function accumulateImageRecord(
  prev: IncidentImageSignal | undefined,
  type: string,
  data: Record<string, unknown>,
): IncidentImageSignal | undefined {
  switch (type) {
    case "image.requested": {
      const provider = asString(data.provider);
      const next: IncidentImageSignal = prev ?? { provider: provider ?? "", outcome: "failed", delivered: false };
      if (provider !== undefined && next.provider.length === 0) next.provider = provider;
      return next;
    }
    case "image.generated":
      return {
        provider: asString(data.provider) ?? prev?.provider ?? "",
        outcome: "ok",
        delivered: prev?.delivered ?? false,
        ...(asString(data.model) !== undefined ? { model: asString(data.model) } : {}),
        ...(asNumber(data.costUsd) !== undefined ? { costUsd: asNumber(data.costUsd) } : {}),
        // WR-02 (186): carry the degraded-delivery flag (false on a persist-failed
        // but base64-delivered generation — still a charged outcome:"ok" turn).
        ...(typeof data.persisted === "boolean" ? { persisted: data.persisted } : {}),
      };
    case "image.delivered": {
      const next: IncidentImageSignal = prev ?? { provider: "", outcome: "ok", delivered: false };
      next.delivered = data.delivered === true;
      return next;
    }
    case "image.failed": {
      const errorKind = asString(data.errorKind);
      return {
        provider: asString(data.provider) ?? prev?.provider ?? "",
        outcome: "failed",
        delivered: prev?.delivered ?? false,
        ...(errorKind !== undefined ? { errorKind } : {}),
      };
    }
    default:
      return prev;
  }
}
