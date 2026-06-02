// SPDX-License-Identifier: Apache-2.0
// @allow-throw: composition-root helper — errors propagate to bootFoundation which catches + exits.
/**
 * Construct the shared-backing-map SecretManager and the daemon-owned MutableSecretManager handle.
 *
 * The returned `secretManager` is passed into `BootstrapOptions.secretManager` so the AppContainer
 * holds the SAME object whose backing Map the handlers can write via `mutableHandle`. After any
 * `mutableHandle.upsert(key, value)`, the broker and exec — which hold `container.secretManager`
 * and call `.get()` per request — observe the new value on their next invocation with no restart.
 *
 * The daemon composition root holds `mutableHandle` and threads it to handler deps only.
 * It must NEVER appear on AppContainer or any agent-accessible path.
 *
 * @module
 */

import {
  createSecretManagerWithMutableHandle,
  type MutableSecretManager,
  type SecretManager,
} from "@comis/core";

/**
 * Constructs the shared SecretManager + daemon-owned MutableSecretManager over ONE backing Map.
 *
 * Called once in `bootFoundation` BEFORE `bootstrap()`. The returned `secretManager` is injected
 * via `BootstrapOptions.secretManager` so `AppContainer.secretManager` shares the same Map that
 * the RPC handlers write to via `mutableHandle`.
 */
export function setupSecretManager(env: Record<string, string | undefined>): {
  secretManager: SecretManager;
  mutableHandle: MutableSecretManager;
} {
  return createSecretManagerWithMutableHandle(env);
}
