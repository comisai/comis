// SPDX-License-Identifier: Apache-2.0
// @comis/shared - Foundation types and utilities

export type { Result } from "./result.js";
export { ok, err, tryCatch, fromPromise } from "./result.js";
export { suppressError } from "./suppress-error.js";
export { withTimeout, TimeoutError } from "./timeout.js";
export { checkAborted } from "./abort.js";
export { createTTLCache } from "./ttl-cache.js";
export type { TTLCache, TTLCacheOptions } from "./ttl-cache.js";
