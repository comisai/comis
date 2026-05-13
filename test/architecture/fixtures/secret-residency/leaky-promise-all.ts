// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: LEAKY — Promise.all closure escape (Rule 2, RES-PIT-31-1).
 *
 * The handler does `Promise.all([...])` and a closure inside the array
 * captures `secretBinding` from the outer handler scope. Even though
 * `secretBinding` is locally declared inside the handler, the closure
 * makes it escape into Promise.all's runtime — a future GC pin or shared
 * buffer could retain it.
 *
 * Walker assertion: ≥ 1 violation, kind "promise-all-closure-escape".
 */

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface MockSecretStore {
  getDecrypted(name: string): Result<string | undefined, Error>;
}

interface MockDeps {
  secretStore: MockSecretStore;
}

export function createHandlers(deps: MockDeps) {
  return {
    "secrets.parallel": async (params: { name: string }) => {
      const result = deps.secretStore.getDecrypted(params.name);
      if (!result.ok) throw result.error;
      const secretBinding = result.value;

      // VIOLATION: Promise.all closure captures `secretBinding` (matches /secret/i).
      await Promise.all([
        Promise.resolve(1).then(() => secretBinding.length),
        Promise.resolve(2),
      ]);

      return { name: params.name, value: secretBinding };
    },
  };
}
