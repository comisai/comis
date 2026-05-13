// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: SAFE handler.
 *
 * Verifies that checkSecretResidency does NOT flag a correctly-written
 * secret-RPC handler. The plaintext is bound locally inside the handler
 * function and returned directly; no module-level binding, no Promise.all.
 *
 * Walker assertion: zero violations.
 */

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface MockSecretStore {
  getDecrypted(name: string): Result<string | undefined, Error>;
}

interface MockDeps {
  secretStore: MockSecretStore;
  logger: { info: (payload: unknown, msg: string) => void };
}

export function createHandlers(deps: MockDeps) {
  return {
    "secrets.get": async (params: { name: string }) => {
      // SAFE — local-scoped binding, used only on return line, no escape.
      const decryptResult = deps.secretStore.getDecrypted(params.name);
      if (!decryptResult.ok) {
        throw new Error(`Decryption failed for "${params.name}"`);
      }
      deps.logger.info({ name: params.name }, "Secret retrieved");
      return { name: params.name, value: decryptResult.value };
    },
  };
}
