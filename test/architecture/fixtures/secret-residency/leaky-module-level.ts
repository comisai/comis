// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: LEAKY — module-level binding violation (Rule 1).
 *
 * `secretValue` is a module-level `const` whose initializer is a
 * SecretStorePort.getDecrypted call. The plaintext lives in process memory
 * for the lifetime of the module (i.e., as long as the daemon runs).
 *
 * Walker assertion: ≥ 1 violation, kind "module-level-binding",
 * bindingName "secretValue".
 */

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface MockSecretStore {
  getDecrypted(name: string): Result<string | undefined, Error>;
}

declare const mockStore: MockSecretStore;

// VIOLATION: module-level const named `secretValue` with secret-source initializer.
const secretValue = mockStore.getDecrypted("BOOTSTRAP_KEY");

export function getSecret(): typeof secretValue {
  return secretValue;
}
