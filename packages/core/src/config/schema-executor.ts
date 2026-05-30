// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { BrokerBindingConfigSchema } from "./schema-broker.js";

/**
 * Executor credential-broker configuration schema (INTEG-02 / WIRE-02).
 *
 * `ExecutorBrokerConfigSchema` describes the broker listening address and
 * named credential bindings. `ExecutorConfigSchema` is the top-level wrapper
 * added as an optional key to `AppConfigSchema` so operator YAML that includes
 * an `executor:` block is accepted by Zod strict mode.
 *
 * Both use `z.strictObject` — unknown keys in operator YAML are rejected at
 * parse time (T-08-01-01 mitigation).
 *
 * @module schema-executor
 */

export const ExecutorBrokerConfigSchema = z.strictObject({
  /** TCP listen port (0 = ephemeral). Default: 0. */
  port: z.number().int().min(0).max(65535).default(0),
  /**
   * Unix socket path for sandbox-to-broker communication.
   * Convention: safePath(dataDir, "broker.sock").
   * Documented as the standard path; callers may override for tests.
   */
  socketPath: z.string().optional(),
  /** Named bindings: each entry maps hosts to injection rules + secretRef. */
  bindings: z.record(z.string().min(1), BrokerBindingConfigSchema).default(() => ({})),
});

export const ExecutorConfigSchema = z.strictObject({
  /** Credential-broker configuration for the executor sandbox. */
  broker: ExecutorBrokerConfigSchema.optional(),
});

export type ExecutorConfig = z.infer<typeof ExecutorConfigSchema>;
export type ExecutorBrokerConfig = z.infer<typeof ExecutorBrokerConfigSchema>;
