// SPDX-License-Identifier: Apache-2.0

/** Browser timeout handle kept behind the web API runtime boundary. */
export type BrowserTimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

/** Schedule a browser timeout from code that cannot receive an injected timer port. */
export function scheduleBrowserTimeout(callback: () => void, delayMs: number): BrowserTimeoutHandle {
  return globalThis.setTimeout(callback, delayMs);
}

/** Cancel a timeout returned by scheduleBrowserTimeout. */
export function cancelBrowserTimeout(handle: BrowserTimeoutHandle): void {
  globalThis.clearTimeout(handle);
}
