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

import {
  type ClockPort,
  type LinkPrefetchReceipt,
  type LinkUnderstandingConfig,
  type WrapExternalContentOptions,
} from "@comis/core";
import { detectLinksInMessage } from "./link-detector.js";
import {
  fetchLinkContent,
  type LinkFetchFailureStage,
} from "./link-fetcher.js";
import { formatLinkContext, injectLinkContext } from "./link-formatter.js";

/**
 * Logger interface required by the link runner.
 */
export interface LinkRunnerLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
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
  /** Injected wall clock for deterministic completion timing. */
  clock: ClockPort;
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
  /** Counts-only prefetch receipt; absent when disabled or no URL syntax was detected. */
  receipt?: LinkPrefetchReceipt;
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
  const { config, logger, clock } = deps;

  const logCompletion = (receipt: LinkPrefetchReceipt): void => {
    logger.info(
      {
        step: "link-understanding",
        ...receipt,
      },
      "Link understanding completed",
    );
  };

  const failureHint = (stage: LinkFetchFailureStage): string => {
    switch (stage) {
      case "validation":
        return "Use a publicly reachable HTTP or HTTPS URL; private, local, reserved, and unresolvable targets are rejected before fetch.";
      case "request":
        return "Check outbound network connectivity and integrations.media.linkUnderstanding.fetchTimeoutMs.";
      case "response":
        return "Verify the public page is reachable without redirects and returns a successful HTTP response.";
      case "extraction":
        return "Verify the public page returns readable text content.";
      default: {
        const _exhaustive: never = stage;
        return _exhaustive;
      }
    }
  };

  const failureLogMessage = (stage: LinkFetchFailureStage): string => {
    switch (stage) {
      case "validation":
        return "URL rejected by SSRF policy";
      case "request":
        return "Link request failed";
      case "response":
        return "Link response was unsuccessful";
      case "extraction":
        return "Link content extraction failed";
      default: {
        const _exhaustive: never = stage;
        return _exhaustive;
      }
    }
  };

  return {
    async processMessage(text: string): Promise<LinkProcessResult> {
      // Short-circuit when disabled
      if (!config.enabled) {
        return { enrichedText: text, linksProcessed: 0, errors: [] };
      }

      const startedAt = clock.now();
      // Step 1: Detect URLs
      const detection = detectLinksInMessage(text, config.maxLinks);
      if (detection.detected === 0) {
        return { enrichedText: text, linksProcessed: 0, errors: [] };
      }

      logger.debug(
        {
          step: "link-detection",
          detected: detection.detected,
          attempted: detection.urls.length,
          invalid: detection.invalid,
          duplicates: detection.duplicates,
          capped: detection.capped,
        },
        "Link understanding detected URL syntax",
      );

      // Step 2: Fetch all URLs concurrently
      const fetchConfig = {
        fetchTimeoutMs: config.fetchTimeoutMs,
        maxContentChars: config.maxContentChars,
        userAgentString: config.userAgentString,
      };

      const settled = await Promise.allSettled(
        detection.urls.map((url) => fetchLinkContent(url, fetchConfig)),
      );

      // Step 3: Collect results and errors
      const successfulResults: Array<{ title: string; content: string; url: string }> = [];
      const errors: string[] = [];
      let validationRejected = 0;

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const url = detection.urls[i];

        if (outcome.status === "rejected") {
          const errorMsg = `${url}: ${String(outcome.reason)}`;
          errors.push(errorMsg);
          logger.warn(
            {
              step: "link-fetch",
              failureStage: "request",
              error: failureLogMessage("request"),
              hint: failureHint("request"),
              errorKind: "dependency" as const,
            },
            "Link understanding fetch rejected",
          );
          continue;
        }

        const result = outcome.value;
        if (!result.ok) {
          if (result.error.stage === "validation") validationRejected += 1;
          const errorMsg = `${url}: ${result.error.error.message}`;
          errors.push(errorMsg);
          logger.warn(
            {
              step: "link-fetch",
              failureStage: result.error.stage,
              error: failureLogMessage(result.error.stage),
              hint: failureHint(result.error.stage),
              errorKind:
                result.error.stage === "validation"
                  ? "precondition" as const
                  : "dependency" as const,
            },
            "Link understanding fetch failed",
          );
          continue;
        }

        successfulResults.push(result.value);
      }

      // Step 4: Format and inject
      const formattedContext = formatLinkContext(successfulResults);
      const enrichedText = injectLinkContext(text, formattedContext, deps.onSuspiciousContent);
      const receipt: LinkPrefetchReceipt = {
        detected: detection.detected,
        attempted: detection.urls.length,
        fetched: successfulResults.length,
        failed: errors.length,
        validationRejected,
        invalid: detection.invalid,
        duplicates: detection.duplicates,
        capped: detection.capped,
        durationMs: Math.max(0, clock.now() - startedAt),
      };
      logCompletion(receipt);

      return {
        enrichedText,
        linksProcessed: successfulResults.length,
        errors,
        receipt,
      };
    },
  };
}
