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
}
