// SPDX-License-Identifier: Apache-2.0
/**
 * Slack Media Handler: Attachment extraction and authenticated file download.
 *
 * Provides:
 * - buildSlackAttachments(): Convert Slack file objects to Attachment[]
 * - isSlackHostname(): Verify a hostname belongs to Slack
 * - fetchWithSlackAuth(): Download Slack files with cross-origin redirect handling
 *
 * Ported from legacy src/slack/monitor/media.ts with simplified interface.
 *
 * @module
 */

import type { Attachment } from "@comis/core";
import type { SlackFile } from "./message-mapper.js";
import { mimeToAttachmentType } from "../shared/media-utils.js";

/**
 * Build an array of Attachment objects from Slack file metadata.
 *
 * Uses `slack-file://{fileId}` as the URL for deferred resolution,
 * matching the tg-file:// pattern used by the Telegram adapter.
 *
 * @param files - Array of Slack file objects from a message event
 * @returns Normalized Attachment array (empty if no files)
 */
export function buildSlackAttachments(files?: SlackFile[]): Attachment[] {
  if (!files || files.length === 0) return [];

  return files.map((file) => ({
    type: mimeToAttachmentType(file.mimetype),
    url: `slack-file://${file.id}`,
    ...(file.mimetype != null && { mimeType: file.mimetype }),
    ...(file.name != null && { fileName: file.name }),
    ...(file.size != null && { sizeBytes: file.size }),
  }));
}

// ---------------------------------------------------------------------------
// Hostname validation
// ---------------------------------------------------------------------------

/**
 * Normalize a hostname for comparison: lowercase, strip trailing dots,
 * strip surrounding brackets (IPv6).
 */
function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

/**
 * Check whether a hostname belongs to a known Slack domain.
 *
 * Slack-hosted files typically come from *.slack.com and redirect to CDN
 * domains. We maintain an allowlist to avoid leaking auth tokens to
 * spoofed or mishandled URLs.
 */
export function isSlackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  const allowedSuffixes = ["slack.com", "slack-edge.com", "slack-files.com"];
  return allowedSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

// ---------------------------------------------------------------------------
// Authenticated file fetch
// ---------------------------------------------------------------------------

/**
 * Validate that a URL is HTTPS and points to a known Slack domain.
 * Throws on invalid URLs to prevent token leakage.
 */
function assertSlackFileUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Slack file URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing Slack file URL with non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (!isSlackHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to send Slack token to non-Slack host "${parsed.hostname}" (url: ${rawUrl})`,
    );
  }
  return parsed;
}

/**
 * Fetch a Slack file URL with Authorization header, handling cross-origin
 * redirects safely.
 *
 * Slack's file URLs redirect to CDN domains with pre-signed URLs that
 * do not need the Authorization header. We:
 * 1. Send the initial request with auth + manual redirect
 * 2. If redirected, follow without auth (CDN URLs are pre-signed)
 * 3. Resolve relative redirect URLs against the original
 *
 * @param url - The Slack file URL (must be HTTPS + Slack domain)
 * @param token - The Slack bot token for Authorization header
 * @returns The fetch Response
 */
export async function fetchWithSlackAuth(url: string, token: string): Promise<Response> {
  const parsed = assertSlackFileUrl(url);

  // Initial request with auth and manual redirect handling
  const initialRes = await fetch(parsed.href, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });

  // If not a redirect, return the response directly
  if (initialRes.status < 300 || initialRes.status >= 400) {
    return initialRes;
  }

  // Handle redirect -- the redirected URL should be pre-signed
  const redirectUrl = initialRes.headers.get("location");
  if (!redirectUrl) {
    return initialRes;
  }

  // Resolve relative URLs against the original
  const resolvedUrl = new URL(redirectUrl, parsed.href);

  // Only follow safe protocols (no auth on redirects)
  if (resolvedUrl.protocol !== "https:") {
    return initialRes;
  }

  // Re-validate redirect hostname against Slack domain allowlist.
  // Prevents auth token leakage if an attacker controls the redirect target.
  // Note: the redirect is followed WITHOUT the Authorization header (CDN URLs
  // are pre-signed), but we still validate to avoid leaking request metadata.
  if (!isSlackHostname(resolvedUrl.hostname)) {
    throw new Error(
      `Refusing to follow redirect to non-Slack host "${resolvedUrl.hostname}" ` +
      `(original: ${parsed.hostname})`,
    );
  }

  // Follow the redirect without the Authorization header
  return fetch(resolvedUrl.toString(), { redirect: "follow" });
}
