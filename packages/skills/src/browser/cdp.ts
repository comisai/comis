/**
 * Chrome DevTools Protocol helpers.
 *
 * Provides lightweight HTTP-based helpers for querying Chrome's CDP
 * endpoints (/json/list, /json/version). These do NOT use WebSocket
 * for protocol messages -- Playwright handles that via connectOverCDP.
 *
 * Ported from Comis browser/cdp.ts + cdp.helpers.ts, stripped of
 * WebSocket CDP messaging, extension relay auth, and complex helpers.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────

/** A CDP target as returned by /json/list. */
export type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  description?: string;
  faviconUrl?: string;
};

/** Chrome version info as returned by /json/version. */
export type CdpVersion = {
  Browser?: string;
  "Protocol-Version"?: string;
  "User-Agent"?: string;
  "V8-Version"?: string;
  "WebKit-Version"?: string;
  webSocketDebuggerUrl?: string;
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Append a path to a CDP base URL, preserving existing path components.
 */
export function appendCdpPath(cdpUrl: string, path: string): string {
  const url = new URL(cdpUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

/**
 * Fetch JSON from a URL with a timeout.
 */
async function fetchJson<T>(url: string, timeoutMs = 1500): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Fetch the list of CDP targets from Chrome.
 *
 * @param cdpUrl - Base CDP URL (e.g., "http://127.0.0.1:9222")
 * @param timeoutMs - Request timeout in milliseconds
 * @returns Array of CDP targets
 */
export async function getCdpTargets(
  cdpUrl: string,
  timeoutMs = 1500,
): Promise<CdpTarget[]> {
  const raw = await fetchJson<
    Array<{
      id?: string;
      type?: string;
      title?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
      devtoolsFrontendUrl?: string;
      description?: string;
      faviconUrl?: string;
    }>
  >(appendCdpPath(cdpUrl, "/json/list"), timeoutMs);

  return raw
    .filter((t) => Boolean(t.id))
    .map((t) => ({
      id: t.id ?? "",
      type: t.type ?? "other",
      title: t.title ?? "",
      url: t.url ?? "",
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
      devtoolsFrontendUrl: t.devtoolsFrontendUrl,
      description: t.description,
      faviconUrl: t.faviconUrl,
    }));
}

/**
 * Fetch Chrome version information.
 *
 * @param cdpUrl - Base CDP URL (e.g., "http://127.0.0.1:9222")
 * @param timeoutMs - Request timeout in milliseconds
 * @returns Chrome version data, or null if unreachable
 */
export async function getCdpVersion(
  cdpUrl: string,
  timeoutMs = 1500,
): Promise<CdpVersion | null> {
  try {
    return await fetchJson<CdpVersion>(
      appendCdpPath(cdpUrl, "/json/version"),
      timeoutMs,
    );
  } catch {
    return null;
  }
}

/**
 * Filter CDP targets to only page-type targets.
 */
export function filterPageTargets(targets: CdpTarget[]): CdpTarget[] {
  return targets.filter((t) => t.type === "page");
}

/**
 * Find a CDP target by its targetId.
 */
export function findTargetById(
  targets: CdpTarget[],
  targetId: string,
): CdpTarget | undefined {
  return targets.find((t) => t.id === targetId);
}
