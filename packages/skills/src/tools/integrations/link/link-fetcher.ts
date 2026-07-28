// SPDX-License-Identifier: Apache-2.0
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
import { ok, err, fromPromise } from "@comis/shared";
import { systemClearTimeout, systemSetTimeout, validateUrl } from "@comis/core";
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

export type LinkFetchFailureStage =
  | "validation"
  | "request"
  | "response"
  | "extraction";

export interface LinkFetchFailure {
  stage: LinkFetchFailureStage;
  error: Error;
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
): Promise<Result<LinkFetchResult, LinkFetchFailure>> {
  // Step 1: SSRF guard validation -- CRITICAL security check
  const validation = await validateUrl(url);
  if (!validation.ok) {
    return err({ stage: "validation", error: validation.error });
  }

  // Step 2: Fetch with timeout
  const controller = new AbortController();
  const timeoutId = systemSetTimeout(() => controller.abort(), config.fetchTimeoutMs);
  const responseResult = await fromPromise(
    fetch(validation.value.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": config.userAgentString,
        Accept: "text/html, application/xhtml+xml, */*;q=0.8",
      },
      redirect: "error",
    }).finally(() => {
      systemClearTimeout(timeoutId);
    }),
  );
  if (!responseResult.ok) {
    return err({ stage: "request", error: responseResult.error });
  }

  // Step 3: Check HTTP status
  const response = responseResult.value;
  if (!response.ok) {
    return err({
      stage: "response",
      error: new Error(`HTTP ${response.status}`),
    });
  }

  // Step 4-5: Extract and bound readable content.
  const extraction = await fromPromise(
    (async (): Promise<LinkFetchResult> => {
      const html = await response.text();
      const readable = await extractReadableContent({
        html,
        url: validation.value.url.toString(),
        extractMode: "text",
      });

      const title = readable?.title ?? "";
      const rawContent = readable?.text ?? "";
      const { text: content } = truncateText(rawContent, config.maxContentChars);
      return { title, content, url: validation.value.url.toString() };
    })(),
  );
  if (!extraction.ok) {
    return err({ stage: "extraction", error: extraction.error });
  }
  return ok(extraction.value);
}
