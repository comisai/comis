/**
 * Shared types for the stream wrapper chain infrastructure.
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";

/**
 * A StreamFn wrapper intercepts and decorates a StreamFn.
 * Takes the "next" function in the chain and returns a new StreamFn.
 * Standard decorator/middleware pattern.
 */
export type StreamFnWrapper = (next: StreamFn) => StreamFn;
