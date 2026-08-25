// SPDX-License-Identifier: Apache-2.0

export interface BoundedServiceStderr {
  append(chunk: Buffer): void;
  text(): string;
}

/** Retain only the newest service stderr bytes while accounting for discarded diagnostics. */
export function createBoundedServiceStderr(maxBytes: number): BoundedServiceStderr {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("live service stderr limit must be a positive safe integer");
  }
  let tail = Buffer.alloc(0);
  let omittedBytes = 0;

  return {
    append(chunk) {
      if (chunk.length === 0) return;
      if (chunk.length >= maxBytes) {
        omittedBytes += tail.length + chunk.length - maxBytes;
        tail = Buffer.from(chunk.subarray(chunk.length - maxBytes));
        return;
      }
      const overflow = Math.max(0, tail.length + chunk.length - maxBytes);
      omittedBytes += overflow;
      tail = Buffer.concat([tail.subarray(overflow), chunk]);
    },
    text() {
      const diagnostic = tail.toString("utf8");
      return omittedBytes === 0
        ? diagnostic
        : `[${omittedBytes} earlier stderr bytes omitted]\n${diagnostic}`;
    },
  };
}
