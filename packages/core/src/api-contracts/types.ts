// SPDX-License-Identifier: Apache-2.0
/**
 * Contract registry shared types.
 *
 * Every RPC method on the gateway has exactly one `ApiContract` entry — the
 * bidirectional 1:1 invariant is enforced in
 * `test/architecture/api-contracts-bidirectional.test.ts`.
 *
 * Barrel-only: external consumers import these types from `"@comis/core"`,
 * never from a sub-path.
 *
 * @module
 */
import type { ZodTypeAny } from "zod";

/** Trust-scope enum mirroring `DynamicMethodRouter`'s runtime check. */
export type Scope = "rpc" | "admin";

/** A single RPC contract entry. */
export interface ApiContract<
  Req extends ZodTypeAny = ZodTypeAny,
  Res extends ZodTypeAny = ZodTypeAny,
> {
  readonly method: string;
  readonly request: Req;
  readonly response: Res;
  readonly scopes: readonly Scope[];
}

/**
 * Identity helper that preserves the `Req` / `Res` type inference when a
 * contract is declared via an object literal. Without this, the inferred
 * `request: ZodObject<{...}>` would widen to the `ZodTypeAny` default.
 */
export function defineContract<
  Req extends ZodTypeAny,
  Res extends ZodTypeAny,
>(contract: ApiContract<Req, Res>): ApiContract<Req, Res> {
  return contract;
}

/**
 * Method-name string narrowing point. Within `@comis/core` this is the broad
 * `string` alias; the generated `packages/web/src/api/contracts.generated.ts`
 * narrows it to a literal union via `keyof typeof CONTRACTS`.
 */
export type MethodName = string;
