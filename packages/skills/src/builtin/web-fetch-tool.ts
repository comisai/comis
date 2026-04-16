/**
 * Web Fetch Tool: Fetch and extract readable content from a URL.
 *
 * Uses @mozilla/readability for HTML extraction, shared caching with TTL,
 * and external content security wrapping. All returned content is wrapped
 * in EXTERNAL_UNTRUSTED_CONTENT markers.
 *
 * Uses impit for Chrome TLS fingerprinting to bypass bot detection.
 *
 * Ported from Comis's web-fetch.ts with adaptations:
 * - SSRF via validateUrl() from @comis/core
 * - Content wrapping via wrapWebContent() from @comis/core
 * - Cache/timeout via web-shared.ts
 * - Readability extraction via web-fetch-utils.ts
 * - No Firecrawl (htmlToMarkdown fallback instead)
 * - No process.env access (config-driven)
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { Impit } from "impit";
import { validateUrl, wrapWebContent, EXTERNAL_CONTENT_WARNING, type WrapExternalContentOptions, FileExtractionConfigSchema } from "@comis/core";
import { createPdfExtractor } from "../integrations/document/pdf-extractor.js";
import {
  detectErrorPagePattern,
  extractReadableContent,
  htmlToMarkdown,
  markdownToText,
  truncateText,
  type ExtractMode,
} from "./web-fetch-utils.js";
import { sanitizeHtmlVisibility, stripInvisibleUnicode } from "./web-fetch-visibility.js";
import type { TTLCache } from "@comis/shared";
import {
  type ReadResponseResult,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  clampMaxBytes,
  normalizeCacheKey,
  createWebCache,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
} from "./web-shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FETCH_MAX_CHARS = 50_000;
const ERROR_BODY_MAX_CHARS = 500;

/** Module-level fetch cache — lazily initialized by factory with resolved TTL. */
let fetchCache: TTLCache<Record<string, unknown>> | undefined;

/**
 * Chrome browser headers for impit TLS fingerprinting.
 * impit impersonates Chrome 125 at the TLS layer; these headers
 * supplement the impersonation at the HTTP layer.
 */
const CHROME_HEADERS: Record<string, string> = {
  "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
};

// Lazy singleton — created on first use so the module import stays side-effect-free.
let impitClient: Impit | undefined;

function getClient(): Impit {
  if (!impitClient) {
    impitClient = new Impit({
      browser: "chrome",
      followRedirects: false, // Block redirects for SSRF protection
      headers: CHROME_HEADERS,
    });
  }
  return impitClient;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const WebFetchParams = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  extractMode: Type.Optional(
    Type.String({
      description: 'Extraction mode: "markdown" (default) or "text".',
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (default 50000).",
    }),
  ),
});

type WebFetchParamsType = Static<typeof WebFetchParams>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WebFetchConfig {
  enabled?: boolean;
  readabilityEnabled?: boolean;
  maxCharsCap?: number;
  /** Maximum response bytes to read via streaming (default 2MB, clamped to 32KB-5MB). */
  maxResponseBytes?: number;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
  userAgent?: string;
  /** Optional callback for suspicious content detection in external content. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveMaxChars(value: unknown, fallback: number, cap: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(100, Math.floor(parsed));
  return Math.min(clamped, cap);
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const [raw] = value.split(";");
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

/**
 * Read text from an impit response with optional byte limiting.
 * Reads the full body via .text() then truncates if over the byte limit.
 */
async function readImpit(
  res: { text: () => Promise<string> },
  options?: { maxBytes?: number },
): Promise<ReadResponseResult> {
  const text = await res.text();
  const bytesRead = Buffer.byteLength(text, "utf-8");

  if (options?.maxBytes && options.maxBytes > 0 && bytesRead > options.maxBytes) {
    const buf = Buffer.from(text, "utf-8");
    const truncatedText = buf.subarray(0, options.maxBytes).toString("utf-8");
    return { text: truncatedText, truncated: true, bytesRead: options.maxBytes };
  }

  return { text, truncated: false, bytesRead };
}

// ---------------------------------------------------------------------------
// Reusable fetch primitive (used by web_fetch tool and web_search deep fetch)
// ---------------------------------------------------------------------------

/**
 * Fetch and extract readable content from a URL.
 * Reusable core for both web_fetch tool and web_search deep fetch.
 *
 * Returns an object with `text`, `title`, `error`, `tookMs`, and metadata.
 * On any failure (SSRF, HTTP error, timeout), returns `{ error: string }` instead of throwing.
 */
export async function fetchUrlContent(params: {
  url: string;
  extractMode?: ExtractMode;
  maxChars?: number;
  maxResponseBytes?: number;
  timeoutSeconds?: number;
  readabilityEnabled?: boolean;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<{
  url: string;
  text?: string;
  title?: string;
  error?: string;
  tookMs: number;
  status?: number;
  extractor?: string;
  truncated?: boolean;
}> {
  const extractMode: ExtractMode = params.extractMode === "text" ? "text" : "markdown";
  const maxChars = params.maxChars ?? 10_000;
  const maxResponseBytes = params.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const readabilityEnabled = params.readabilityEnabled !== false;

  // SSRF validation
  const urlCheck = await validateUrl(params.url);
  if (!urlCheck.ok) {
    return {
      url: params.url,
      error: `SSRF blocked: ${urlCheck.error.message}`,
      tookMs: 0,
    };
  }

  // Rewrite arxiv PDF URLs to abstract page (faster, richer HTML content)
  const arxivPdfMatch = params.url.match(/^https?:\/\/arxiv\.org\/pdf\/(\d+\.\d+)/);
  let url = params.url;
  if (arxivPdfMatch) {
    url = `https://arxiv.org/abs/${arxivPdfMatch[1]}`;
  }

  const client = getClient();
  const start = Date.now();
  let res: { ok: boolean; status: number; statusText: string; headers: Headers; text: () => Promise<string>; bytes: () => Promise<Uint8Array> };
  try {
    res = await client.fetch(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
      },
      timeout: timeoutSeconds * 1000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      url: params.url,
      error: `Fetch failed: ${message}`,
      tookMs: Date.now() - start,
    };
  }

  // Detect redirects (blocked for SSRF protection)
  if (res.status >= 300 && res.status < 400) {
    return {
      url: params.url,
      error: "URL redirected to a different location. Redirects are blocked for security.",
      tookMs: Date.now() - start,
      status: res.status,
    };
  }

  if (!res.ok) {
    const { text: detail } = await readImpit(res);
    const patternMessage = detectErrorPagePattern(detail);
    const truncatedDetail = truncateText(detail, ERROR_BODY_MAX_CHARS).text;
    return {
      url: params.url,
      error: patternMessage ?? `HTTP ${res.status}: ${truncatedDetail || res.statusText}`,
      tookMs: Date.now() - start,
      status: res.status,
    };
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";

  // PDF extraction: read binary bytes, delegate to createPdfExtractor
  const normalizedCt = normalizeContentType(contentType);
  if (normalizedCt === "application/pdf") {
    const bytes = await res.bytes();
    const buffer = Buffer.from(bytes);
    const config = FileExtractionConfigSchema.parse({});
    const extractor = createPdfExtractor({ config });
    const pdfResult = await extractor.extract({
      source: "buffer",
      buffer,
      mimeType: "application/pdf",
      fileName: url.split("/").pop() || "document.pdf",
    });
    if (pdfResult.ok) {
      const truncated = truncateText(pdfResult.value.text, maxChars);
      return {
        url: params.url,
        text: truncated.text,
        title: pdfResult.value.fileName,
        tookMs: Date.now() - start,
        status: res.status,
        extractor: "pdf",
        truncated: truncated.truncated,
      };
    }
    return {
      url: params.url,
      error: `PDF extraction failed: ${pdfResult.error.message}`,
      tookMs: Date.now() - start,
      status: res.status,
    };
  }

  const { text: body, truncated: bodyTruncated, bytesRead } = await readImpit(res, {
    maxBytes: maxResponseBytes,
  });

  let title: string | undefined;
  let extractor = "raw";
  let text = body;

  if (contentType.includes("text/html")) {
    if (readabilityEnabled) {
      const readable = await extractReadableContent({
        html: body,
        url: params.url,
        extractMode,
      });
      if (readable?.text) {
        text = readable.text;
        title = readable.title;
        extractor = "readability";
      } else {
        const sanitized = sanitizeHtmlVisibility(body);
        const rendered = htmlToMarkdown(sanitized.html);
        text = extractMode === "text" ? markdownToText(rendered.text) : rendered.text;
        text = stripInvisibleUnicode(text);
        title = rendered.title;
        extractor = "htmlToMarkdown";
      }
    } else {
      const sanitized = sanitizeHtmlVisibility(body);
      const rendered = htmlToMarkdown(sanitized.html);
      text = extractMode === "text" ? markdownToText(rendered.text) : rendered.text;
      text = stripInvisibleUnicode(text);
      title = rendered.title;
      extractor = "htmlToMarkdown";
    }
  } else if (contentType.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
      extractor = "json";
    } catch {
      text = body;
      extractor = "raw";
    }
  }

  // Prepend byte-level truncation marker
  if (bodyTruncated) {
    text = `[Response truncated at ${bytesRead} bytes (limit: ${maxResponseBytes}). For full content, use targeted CSS selectors or extract specific sections.]\n\n${text}`;
  }

  // Truncate (char-level)
  const truncated = truncateText(text, maxChars);

  return {
    url: params.url,
    text: truncated.text,
    title,
    tookMs: Date.now() - start,
    status: res.status,
    extractor,
    truncated: truncated.truncated,
  };
}

// ---------------------------------------------------------------------------
// Core fetch logic (web_fetch tool — adds caching + content wrapping)
// ---------------------------------------------------------------------------

async function runWebFetch(params: {
  url: string;
  extractMode: ExtractMode;
  maxChars: number;
  maxResponseBytes: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  readabilityEnabled: boolean;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.maxChars}`,
  );
  const cached = fetchCache?.get(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  // SSRF validation
  const urlCheck = await validateUrl(params.url);
  if (!urlCheck.ok) {
    return {
      url: params.url,
      error: `SSRF blocked: ${urlCheck.error.message}`,
    };
  }

  // Rewrite arxiv PDF URLs to abstract page (faster, richer HTML content)
  const arxivPdfMatch = params.url.match(/^https?:\/\/arxiv\.org\/pdf\/(\d+\.\d+)/);
  let url = params.url;
  if (arxivPdfMatch) {
    url = `https://arxiv.org/abs/${arxivPdfMatch[1]}`;
  }

  const client = getClient();
  const start = Date.now();
  let res: { ok: boolean; status: number; statusText: string; headers: Headers; text: () => Promise<string>; bytes: () => Promise<Uint8Array> };
  try {
    res = await client.fetch(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
      },
      timeout: params.timeoutSeconds * 1000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      url: params.url,
      error: `Fetch failed: ${message}`,
    };
  }

  // Detect redirects (blocked for SSRF protection — impit returns 3xx with followRedirects: false)
  if (res.status >= 300 && res.status < 400) {
    return {
      url: params.url,
      error: "URL redirected to a different location. Redirects are blocked for security.",
    };
  }

  if (!res.ok) {
    const { text: detail } = await readImpit(res);
    const rawContentLength = res.headers.get("content-length");
    const contentLength =
      rawContentLength !== null ? Number.parseInt(rawContentLength, 10) : null;
    const patternMessage = detectErrorPagePattern(detail);
    const truncatedDetail = truncateText(detail, ERROR_BODY_MAX_CHARS).text;
    return {
      url: params.url,
      status: res.status,
      contentLength: contentLength !== null && Number.isFinite(contentLength) ? contentLength : null,
      error: patternMessage ?? `HTTP ${res.status}: ${truncatedDetail || res.statusText}`,
      errorBody: truncatedDetail || undefined,
      errorBodyTruncated: detail.length > ERROR_BODY_MAX_CHARS,
    };
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const normalizedContentType = normalizeContentType(contentType) ?? "application/octet-stream";
  const rawContentLength = res.headers.get("content-length");
  const contentLength =
    rawContentLength !== null ? Number.parseInt(rawContentLength, 10) : null;

  // PDF extraction: read binary bytes, delegate to createPdfExtractor
  if (normalizedContentType === "application/pdf") {
    const bytes = await res.bytes();
    const buffer = Buffer.from(bytes);
    const config = FileExtractionConfigSchema.parse({});
    const extractor = createPdfExtractor({ config });
    const pdfResult = await extractor.extract({
      source: "buffer",
      buffer,
      mimeType: "application/pdf",
      fileName: url.split("/").pop() || "document.pdf",
    });
    if (pdfResult.ok) {
      const truncated = truncateText(pdfResult.value.text, params.maxChars);
      const wrappedText = wrapWebContent(truncated.text, "web_fetch", params.onSuspiciousContent, false);
      const payload: Record<string, unknown> = {
        url: params.url,
        finalUrl: url,
        status: res.status,
        contentType: "application/pdf",
        title: pdfResult.value.fileName,
        extractMode: params.extractMode,
        extractor: "pdf",
        truncated: truncated.truncated,
        bytesRead: buffer.length,
        totalBytes: contentLength !== null && Number.isFinite(contentLength) ? contentLength : null,
        bodyTruncated: false,
        length: wrappedText.length,
        fetchedAt: new Date().toISOString(),
        tookMs: Date.now() - start,
        text: wrappedText,
        pageCount: pdfResult.value.pageCount,
        totalPages: pdfResult.value.totalPages,
      };
      fetchCache?.set(cacheKey, payload);
      return payload;
    }
    return {
      url: params.url,
      error: `PDF extraction failed: ${pdfResult.error.message}`,
      status: res.status,
    };
  }

  const { text: body, truncated: bodyTruncated, bytesRead } = await readImpit(res, {
    maxBytes: params.maxResponseBytes,
  });

  let title: string | undefined;
  let extractor = "raw";
  let text = body;

  if (contentType.includes("text/html")) {
    if (params.readabilityEnabled) {
      // extractReadableContent handles sanitization internally
      const readable = await extractReadableContent({
        html: body,
        url: params.url,
        extractMode: params.extractMode,
      });
      if (readable?.text) {
        text = readable.text;
        title = readable.title;
        extractor = "readability";
      } else {
        // Readability failed, fall back to htmlToMarkdown
        const sanitized = sanitizeHtmlVisibility(body);
        const rendered = htmlToMarkdown(sanitized.html);
        text =
          params.extractMode === "text" ? markdownToText(rendered.text) : rendered.text;
        text = stripInvisibleUnicode(text);
        title = rendered.title;
        extractor = "htmlToMarkdown";
      }
    } else {
      // Readability disabled, sanitize + use htmlToMarkdown directly
      const sanitized = sanitizeHtmlVisibility(body);
      const rendered = htmlToMarkdown(sanitized.html);
      text =
        params.extractMode === "text" ? markdownToText(rendered.text) : rendered.text;
      text = stripInvisibleUnicode(text);
      title = rendered.title;
      extractor = "htmlToMarkdown";
    }
  } else if (contentType.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
      extractor = "json";
    } catch {
      text = body;
      extractor = "raw";
    }
  }

  // Prepend byte-level truncation marker before char-level truncation
  if (bodyTruncated) {
    text = `[Response truncated at ${bytesRead} bytes (limit: ${params.maxResponseBytes}). For full content, use targeted CSS selectors or extract specific sections.]\n\n${text}`;
  }

  // Truncate (char-level)
  const truncated = truncateText(text, params.maxChars);

  // Wrap all content with security markers
  const wrappedText = wrapWebContent(truncated.text, "web_fetch", params.onSuspiciousContent, false);
  const wrappedTitle = title ? wrapWebContent(title, "web_fetch", params.onSuspiciousContent, false) : undefined;

  const payload: Record<string, unknown> = {
    url: params.url,
    finalUrl: url,
    status: res.status,
    contentType: normalizedContentType,
    title: wrappedTitle,
    extractMode: params.extractMode,
    extractor,
    truncated: truncated.truncated,
    bytesRead,
    totalBytes: contentLength !== null && Number.isFinite(contentLength) ? contentLength : null,
    bodyTruncated,
    length: wrappedText.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
    text: wrappedText,
  };

  fetchCache?.set(cacheKey, payload);
  return payload;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a web fetch tool with readability extraction and content wrapping.
 * Uses impit Chrome TLS fingerprinting to avoid bot detection.
 *
 * @param config - Optional configuration for the fetch tool
 * @returns AgentTool implementing the web fetch interface
 */
export function createWebFetchTool(
  config?: WebFetchConfig,
): AgentTool<typeof WebFetchParams> {
  const onSuspiciousContent = config?.onSuspiciousContent;
  const readabilityEnabled = config?.readabilityEnabled !== false;
  const maxCharsCap =
    typeof config?.maxCharsCap === "number" && Number.isFinite(config.maxCharsCap)
      ? Math.max(100, Math.floor(config.maxCharsCap))
      : DEFAULT_FETCH_MAX_CHARS;
  const maxResponseBytes = clampMaxBytes(config?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  const timeoutSeconds = resolveTimeoutSeconds(
    config?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const cacheTtlMs = resolveCacheTtlMs(
    config?.cacheTtlMinutes,
    DEFAULT_CACHE_TTL_MINUTES,
  );

  // Initialize module-level cache with resolved TTL (shared across factory calls)
  if (!fetchCache) {
    fetchCache = createWebCache<Record<string, unknown>>(cacheTtlMs);
  }

  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract readable content from a URL (HTML -> markdown/text). Use for lightweight page access without browser automation.",
    parameters: WebFetchParams,

    async execute(
      _toolCallId: string,
      params: WebFetchParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const extractMode: ExtractMode =
          params.extractMode === "text" ? "text" : "markdown";
        const maxChars = resolveMaxChars(
          params.maxChars,
          DEFAULT_FETCH_MAX_CHARS,
          maxCharsCap,
        );

        const result = await runWebFetch({
          url: params.url,
          extractMode,
          maxChars,
          maxResponseBytes,
          timeoutSeconds,
          cacheTtlMs,
          readabilityEnabled,
          onSuspiciousContent,
        });

        const text = JSON.stringify(result, null, 2);
        const prefix = result.error ? "" : `${EXTERNAL_CONTENT_WARNING}\n\n`;
        return {
          content: [{ type: "text", text: `${prefix}${text}` }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

/**
 * Exported for testing: clears the internal fetch cache.
 */
export function __clearFetchCache(): void {
  fetchCache?.clear();
}
