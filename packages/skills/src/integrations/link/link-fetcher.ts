/**
 * SSRF-safe URL content fetcher for link understanding.
 *
 * Every URL passes through validateUrl() (SSRF guard) before any outbound
 * request is made. Content is extracted via readability into clean text.
 *
 * SECURITY: validateUrl() call is CRITICAL -- it prevents server-side
 * request forgery by blocking private IPs, loopback, cloud metadata, etc.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { validateUrl } from "@comis/core";
import {
  extractReadableContent,
  truncateText,
} from "../../builtin/web-fetch-utils.js";

export interface LinkFetchConfig {
  /** Timeout for the fetch request in milliseconds */
  fetchTimeoutMs: number;
  /** Maximum characters of extracted content */
  maxContentChars: number;
  /** User-Agent header for outbound requests */
  userAgentString: string;
}

export interface LinkFetchResult {
  /** Page title extracted from HTML */
  title: string;
  /** Clean readable content extracted from page */
  content: string;
  /** The fetched URL */
  url: string;
}

/**
 * Fetch the content of a URL with SSRF protection and readability extraction.
 *
 * Steps:
 * 1. Validate URL via SSRF guard (blocks private IPs, loopback, metadata)
 * 2. Fetch with timeout and User-Agent header
 * 3. Check HTTP status
 * 4. Extract readable content via readability
 * 5. Truncate to maxContentChars
 *
 * @param url - The URL to fetch
 * @param config - Fetch configuration (timeout, max chars, user agent)
 * @returns ok with title/content/url on success, err on any failure
 */
export async function fetchLinkContent(
  url: string,
  config: LinkFetchConfig,
): Promise<Result<LinkFetchResult, Error>> {
  try {
    // Step 1: SSRF guard validation -- CRITICAL security check
    const validation = await validateUrl(url);
    if (!validation.ok) {
      return err(validation.error);
    }

    // Step 2: Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": config.userAgentString,
          Accept: "text/html, application/xhtml+xml, */*;q=0.8",
        },
        redirect: "error",
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Step 3: Check HTTP status
    if (!response.ok) {
      return err(new Error(`HTTP ${response.status}`));
    }

    // Step 4: Extract readable content
    const html = await response.text();
    const readable = await extractReadableContent({
      html,
      url,
      extractMode: "text",
    });

    const title = readable?.title ?? "";
    const rawContent = readable?.text ?? "";

    // Step 5: Truncate to maxContentChars
    const { text: content } = truncateText(rawContent, config.maxContentChars);

    return ok({ title, content, url });
  } catch (error) {
    return err(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
