// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for the retired hand-maintained `RpcMethodMap` interface; replaced by
 * the generated CONTRACTS dispatch table. New code MUST import
 * {@link MethodName} / {@link validateRequest} / {@link validateResponse} /
 * `CONTRACTS` directly from `../contracts.generated.js` (single source of
 * truth — `pnpm contracts:generate`).
 *
 * @module
 */

import type { RpcClient } from "../rpc-client.js";
import {
  type MethodName,
  validateRequest,
  validateResponse,
} from "../contracts.generated.js";

/** Union of every valid RPC method name (driven by the generated artifact). */
export type RpcMethod = MethodName;

/** Compile-time-typed RPC call signature; runtime validation lives separately. */
export type TypedRpcCall = <M extends RpcMethod>(
  method: M,
  params?: unknown,
) => Promise<unknown>;

/** Create a typed RPC wrapper. See api-client.ts `typedCall` for validating use. */
export function createTypedRpc(rpc: RpcClient): TypedRpcCall {
  return ((method: string, params?: unknown) => rpc.call(method, params)) as TypedRpcCall;
}

export { validateRequest, validateResponse, type MethodName };
