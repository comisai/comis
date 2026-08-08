// SPDX-License-Identifier: Apache-2.0
/**
 * Process-local metadata for utility-model calls that reuse a session stream.
 *
 * @module
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";

const AUXILIARY_STREAM_CALL = Symbol.for("comis.auxiliary-stream-call");

type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;

/** Mark a utility-model dispatch so session-scoped stream wrappers do not
 * interpret its unrelated payload as the parent conversation. The symbol is
 * process-local request metadata and cannot be serialized onto provider APIs. */
export function markAuxiliaryStreamCall(options: StreamOptions | undefined): StreamOptions {
  return { ...options, [AUXILIARY_STREAM_CALL]: true } as StreamOptions;
}

/** Whether this dispatch belongs to a utility-model lane rather than the
 * parent conversation whose stream wrapper chain is being reused. */
export function isAuxiliaryStreamCall(options: StreamOptions | undefined): boolean {
  return (options as Record<PropertyKey, unknown> | undefined)?.[AUXILIARY_STREAM_CALL] === true;
}
