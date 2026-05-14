// SPDX-License-Identifier: Apache-2.0
/**
 * EnvPort: hexagonal boundary for environment-variable reads.
 *
 * The only sanctioned process.env consumer is daemon.ts at the composition root
 * (post-secret-decryption merge). Every other caller receives an injected EnvPort
 * and calls env.get(KEY).
 *
 * Type-only file — adapter `createSystemEnv()` lives in @comis/infra.
 *
 * @module
 */

export interface EnvPort {
  get(key: string): string | undefined;
  /**
   * Read multiple keys at once. Returns a frozen snapshot — useful for
   * config-bootstrap paths that must not see mutation mid-load.
   */
  snapshot(keys: readonly string[]): Readonly<Record<string, string | undefined>>;
}
