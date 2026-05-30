// SPDX-License-Identifier: Apache-2.0
/**
 * Broker placeholder env-var builder (INTEG-03).
 *
 * Extracted from daemon.ts so the function is unit-testable.
 * Builds the placeholder env-var map from broker binding config.
 *
 * SECURITY: NEVER calls secretManager.get() — uses only the key NAME for the
 * env var. Real secrets stay in SecretManager and are resolved by the broker
 * per-request at the HTTP header layer.
 * @module
 */

import type { BrokerBindingConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** Regex matching env-var-shaped names: uppercase letter, then uppercase+digits+underscore. */
const ENV_VAR_SHAPED_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Build the placeholder env-var mapping from binding config for INTEG-03.
 * Maps each binding's env var name (envVarName ?? secretRef) to the placeholder
 * string "comis-broker-placeholder".
 *
 * WR-02 guard: when envVarName is absent and secretRef does not match the env-var
 * naming convention (^[A-Z][A-Z0-9_]*$), a WARN is emitted. The placeholder will
 * land under the wrong env var name and the driven CLI will silently fail to find
 * its API key (→ 401 from the downstream API, not a clean 407 from the broker).
 * Operators must set envVarName explicitly for opaque secretRef values.
 */
export function buildPlaceholdersFromBindings(
  bindings: Record<string, BrokerBindingConfig>,
  logger: ComisLogger,
): Record<string, string> {
  return Object.fromEntries(
    Object.values(bindings).map((b) => {
      const key = b.envVarName ?? b.secretRef;
      if (!b.envVarName && !ENV_VAR_SHAPED_RE.test(b.secretRef)) {
        logger.warn(
          {
            secretRef: b.secretRef,
            hint: "Set envVarName explicitly when secretRef is an opaque key name — the placeholder would otherwise land under the wrong env var name",
            errorKind: "config" as const,
          },
          "Broker binding: secretRef is not env-var-shaped and envVarName is absent; placeholder may not match CLI env var name",
        );
      }
      return [key, "comis-broker-placeholder"];
    }),
  );
}
