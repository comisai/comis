/**
 * Block pacer -- timed delivery of text blocks with coalescing and cancellation.
 *
 * Delivers blocks with configurable timing delays (off/natural/custom/adaptive).
 * Consecutive short blocks are optionally coalesced into a single send to prevent
 * notification spam. Supports graceful cancellation (remaining blocks
 * sent immediately without delay).
 */

import type { DeliveryTimingConfig } from "@comis/core";

import { calculateDelay, type BlockTimingContext } from "./delivery-timing.js";

/** Configuration for block pacing behavior. */
export interface PacerConfig {
  /** Delivery timing configuration (replaces minDelayMs/maxDelayMs) */
  timingConfig: DeliveryTimingConfig;
  /** Maximum characters before coalesced blocks are flushed */
  coalesceMaxChars: number;
  /** When true, skip internal coalescing (external coalescer handles it) */
  disableCoalescing?: boolean;
  /**
   * External abort signal. When aborted, delivery stops entirely
   * (unlike cancel() which sends remaining immediately).
   */
  externalSignal?: AbortSignal;
}

/** Block pacer interface for timed delivery with cancellation. */
export interface BlockPacer {
  /**
   * Deliver blocks with pacing delays and coalescing.
   *
   * @param blocks - Ordered text blocks to deliver
   * @param send - Async function to send a single text block
   */
  deliver(
    blocks: string[],
    send: (text: string) => Promise<void>,
  ): Promise<void>;

  /** Cancel pacing -- remaining blocks are sent immediately without delay. */
  cancel(): void;
}

/**
 * Delay helper that resolves after ms or immediately when aborted.
 *
 * @returns true if delay completed normally, false if aborted
 */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Coalesce consecutive blocks into groups that fit within maxChars.
 *
 * Short consecutive blocks are joined with double newlines to prevent
 * notification spam. A group is flushed when adding the next block
 * would exceed the character limit.
 */
function coalesceBlocks(
  blocks: string[],
  maxChars: number,
): string[] {
  if (blocks.length <= 1) {
    return [...blocks];
  }

  const joiner = "\n\n";
  const groups: string[] = [];
  let buffer = blocks[0];

  for (let i = 1; i < blocks.length; i++) {
    const next = blocks[i];
    const combined = buffer + joiner + next;

    if (combined.length <= maxChars) {
      buffer = combined;
    } else {
      groups.push(buffer);
      buffer = next;
    }
  }

  // Flush remaining buffer
  if (buffer.length > 0) {
    groups.push(buffer);
  }

  return groups;
}

/**
 * Create a block pacer with configurable timing, optional coalescing, and cancellation.
 *
 * @param config - Pacing configuration
 * @returns BlockPacer instance
 */
export function createBlockPacer(config: PacerConfig): BlockPacer {
  const controller = new AbortController();

  // Combine internal cancel signal with external abort signal so either can
  // interrupt delays. External abort = hard stop (skip remaining).
  // Internal cancel = graceful (send remaining immediately).
  const combinedSignal = config.externalSignal
    ? AbortSignal.any([controller.signal, config.externalSignal])
    : controller.signal;

  return {
    async deliver(
      blocks: string[],
      send: (text: string) => Promise<void>,
    ): Promise<void> {
      if (blocks.length === 0) {
        return;
      }

      // Coalesce short consecutive blocks (skip when external coalescer active)
      const groups = config.disableCoalescing
        ? [...blocks]
        : coalesceBlocks(blocks, config.coalesceMaxChars);

      for (let i = 0; i < groups.length; i++) {
        // External abort: hard stop -- do NOT send remaining blocks
        if (config.externalSignal?.aborted) {
          return;
        }

        // Build timing context for this block
        const ctx: BlockTimingContext = {
          blockIndex: i,
          totalBlocks: groups.length,
          blockCharCount: groups[i].length,
          isFirstBlock: i === 0,
        };
        const ms = calculateDelay(config.timingConfig, ctx);

        // Apply delay when ms > 0 (handles first block delay + inter-block delays)
        if (ms > 0) {
          if (combinedSignal.aborted) {
            // Check source: external abort = hard stop, internal cancel = graceful
            if (config.externalSignal?.aborted) {
              return;
            }
            // Graceful shutdown: send remaining blocks immediately
            await send(groups[i]);
            continue;
          }

          const completed = await delay(ms, combinedSignal);

          if (!completed) {
            // Check source: external abort = hard stop, internal cancel = graceful
            if (config.externalSignal?.aborted) {
              return;
            }
            // Internal cancel: send this and remaining blocks immediately
            for (let j = i; j < groups.length; j++) {
              await send(groups[j]);
            }
            return;
          }
        }

        await send(groups[i]);
      }
    },

    cancel(): void {
      controller.abort();
    },
  };
}
