// SPDX-License-Identifier: Apache-2.0

/** Closed failure kinds whose structured details are safe to project downstream. */
export type MediaResolutionErrorKind = "size_exceeded";

export interface MediaResolutionErrorOptions {
  readonly kind: MediaResolutionErrorKind;
  readonly sizeBytes: number;
  readonly maxBytes: number;
}

/**
 * Structured media-resolution failure for deterministic local guards.
 *
 * Provider/network failures remain ordinary `Error` values because their raw
 * messages are not safe prompt context. This class is reserved for bounded,
 * content-free facts that the runtime can expose honestly to the current turn.
 */
export class MediaResolutionError extends Error {
  readonly kind: MediaResolutionErrorKind;
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(options: MediaResolutionErrorOptions) {
    super(`Media size ${options.sizeBytes} exceeds limit of ${options.maxBytes} bytes`);
    this.name = "MediaResolutionError";
    this.kind = options.kind;
    this.sizeBytes = options.sizeBytes;
    this.maxBytes = options.maxBytes;
  }
}
