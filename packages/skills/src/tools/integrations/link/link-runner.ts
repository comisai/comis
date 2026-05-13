// SPDX-License-Identifier: Apache-2.0
/**
 * Link understanding pipeline runner.
 *
 * Orchestrates the detect -> fetch -> format pipeline for automatic
 * link understanding. Processes URLs concurrently with graceful error
 * handling and logging.
 *
 * @module
 */

import type { LinkUnderstandingConfig, WrapExternalContentOptions } from "@comis/core";
import { extractLinksFromMessage } from "./link-detector.js";
import { fetchLinkContent } from "./link-fetcher.js";
import { formatLinkContext, injectLinkContext } from "./link-formatter.js";

/**
 * Logger interface required by the link runner.
 */
export interface LinkRunnerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Dependencies for creating a link runner.
 */
export interface LinkRunnerDeps {
  /** Link understanding configuration */
  config: LinkUnderstandingConfig;
  /** Logger instance */
  logger: LinkRunnerLogger;
  /** Optional callback for suspicious content detection. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

/**
 * Result of processing a message through the link pipeline.
 */
export interface LinkProcessResult {
  /** Original text enriched with link context */
  enrichedText: string;
  /** Number of links successfully processed */
  linksProcessed: number;
  /** Error messages for failed links */
  errors: string[];
}

/**
 * Link runner interface: processes messages to detect, fetch, and inject link context.
 */
export interface LinkRunner {
  processMessage(text: string): Promise<LinkProcessResult>;
}

/**
 * Create a link runner that orchestrates the link understanding pipeline.
 *
 * When disabled, returns the original text unchanged (short-circuit).
 * When enabled, detects URLs, fetches them concurrently via SSRF-safe
 * fetcher, formats readable content, and injects it into the message.
 *
 * @param deps - Configuration and logger
 * @returns LinkRunner instance
 */
export function createLinkRunner(deps: LinkRunnerDeps): LinkRunner {
  const { config, logger } = deps;

  return {
    async processMessage(text: string): Promise<LinkProcessResult> {
      // Short-circuit when disabled
      if (!config.enabled) {
        return { enrichedText: text, linksProcessed: 0, errors: [] };
      }

      // Step 1: Detect URLs
      const urls = extractLinksFromMessage(text, config.maxLinks);
      if (urls.length === 0) {
        return { enrichedText: text, linksProcessed: 0, errors: [] };
      }

      logger.info({ urls, count: urls.length }, "Link understanding: detected URLs");

      // Step 2: Fetch all URLs concurrently
      const fetchConfig = {
        fetchTimeoutMs: config.fetchTimeoutMs,
        maxContentChars: config.maxContentChars,
        userAgentString: config.userAgentString,
      };

      const settled = await Promise.allSettled(
        urls.map((url) => fetchLinkContent(url, fetchConfig)),
      );

      // Step 3: Collect results and errors
      const successfulResults: Array<{ title: string; content: string; url: string }> = [];
      const errors: string[] = [];

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const url = urls[i];

        if (outcome.status === "rejected") {
          const errorMsg = `${url}: ${String(outcome.reason)}`;
          errors.push(errorMsg);
          logger.warn({ url, error: String(outcome.reason), hint: "Link fetch was rejected; URL may be unreachable or timed out", errorKind: "network" as const }, "Link understanding: fetch rejected");
          continue;
        }

        const result = outcome.value;
        if (!result.ok) {
          const errorMsg = `${url}: ${result.error.message}`;
          errors.push(errorMsg);
          logger.warn({ url, error: result.error.message, hint: "Link content extraction failed; link will not be summarized", errorKind: "network" as const }, "Link understanding: fetch failed");
          continue;
        }

        successfulResults.push(result.value);
        logger.info(
          { url, titleLength: result.value.title.length, contentLength: result.value.content.length },
          "Link understanding: fetched content",
        );
      }

      // Step 4: Format and inject
      const formattedContext = formatLinkContext(successfulResults);
      const enrichedText = injectLinkContext(text, formattedContext, deps.onSuspiciousContent);

      return {
        enrichedText,
        linksProcessed: successfulResults.length,
        errors,
      };
    },
  };
}
