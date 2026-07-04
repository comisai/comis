// SPDX-License-Identifier: Apache-2.0
/**
 * Pure outbound helpers for the Microsoft Teams adapter.
 *
 * Each function here reads only its arguments — no closure over adapter state,
 * the injected clock, or `deps` — so they live in this sibling module and are
 * unit-tested in isolation, keeping the adapter module within its size budget.
 *
 * @module
 */

import type { SendMessageOptions } from "@comis/core";

/** Ensure a service base URL ends in a single trailing slash for path composition. */
export function withTrailingSlash(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * Resolve the reply target. A Teams direct message is always sent top-level, so
 * a `dm` chatType forces no replyToId even when the caller supplies one (the
 * delivery layer stamps a reply target on every inbound). Channel and group
 * replies thread under the parent via replyToId; a proactive send with no
 * explicit reply target threads under the stored thread root (channel/group
 * references carry one, a 1:1 does not — so a DM stays top-level).
 */
export function resolveReplyToId(
  options?: SendMessageOptions,
  fallbackThreadId?: string,
): string | undefined {
  // Honor "DM → top-level": never thread a direct message, whatever was passed.
  if (options?.extra?.chatType === "dm") return undefined;
  if (typeof options?.replyTo === "string" && options.replyTo.length > 0) {
    return options.replyTo;
  }
  const fromExtra = options?.extra?.replyToId;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  return typeof fallbackThreadId === "string" && fallbackThreadId.length > 0
    ? fallbackThreadId
    : undefined;
}

/** Extract an explicit typing serviceUrl from the action params (direct or under extra). */
export function resolveTypingServiceUrl(
  params: Record<string, unknown>,
): string | undefined {
  const direct =
    typeof params.serviceUrl === "string" ? params.serviceUrl : undefined;
  const extra = params.extra;
  const fromExtra =
    typeof extra === "object" &&
    extra !== null &&
    typeof (extra as { serviceUrl?: unknown }).serviceUrl === "string"
      ? (extra as { serviceUrl: string }).serviceUrl
      : undefined;
  return direct ?? fromExtra;
}
