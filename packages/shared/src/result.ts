// SPDX-License-Identifier: Apache-2.0
/**
 * Discriminated union for explicit error handling.
 *
 * Use `result.ok` as the discriminant to narrow:
 * ```ts
 * const result = tryCatch(() => riskyOp());
 * if (result.ok) {
 *   console.log(result.value); // T
 * } else {
 *   console.error(result.error); // E
 * }
 * ```
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Create a successful Result wrapping the given value.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Create a failed Result wrapping the given error.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Wrap a non-Error thrown value in an Error instance.
 */
function toError(thrown: unknown): Error {
  if (thrown instanceof Error) {
    return thrown;
  }
  // Guard against malicious objects where toString() throws
  try {
    return new Error(String(thrown));
  } catch {
    return new Error("[non-stringifiable value]");
  }
}

/**
 * Execute a synchronous function and return its result as a Result<T, Error>.
 * Non-Error thrown values are wrapped in Error.
 */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (e: unknown) {
    return err(toError(e));
  }
}

/**
 * Await a promise and return its result as a Result<T, Error>.
 * Non-Error rejection values are wrapped in Error.
 */
export async function fromPromise<T>(promise: Promise<T>): Promise<Result<T, Error>> {
  try {
    const value = await promise;
    return ok(value);
  } catch (e: unknown) {
    return err(toError(e));
  }
}
