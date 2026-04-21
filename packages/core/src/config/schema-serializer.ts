// SPDX-License-Identifier: Apache-2.0
/**
 * Config schema serializer: converts Zod schemas to JSON Schema for agent introspection.
 *
 * Provides cached conversion of the full AppConfig schema and per-section schemas
 * to JSON Schema format. This allows agents to introspect the configuration structure
 * and understand valid values before attempting config patches.
 *
 * @module
 */

import { z } from "zod";
import { AppConfigSchema } from "./schema.js";
import { PerAgentConfigSchema, RoutingConfigSchema } from "./schema-agent.js";
import { ApprovalsConfigSchema } from "./schema-approvals.js";
import { BrowserConfigSchema } from "./schema-browser.js";
import { ChannelConfigSchema } from "./schema-channel.js";
import { DaemonConfigSchema } from "./schema-daemon.js";
import { GatewayConfigSchema } from "./schema-gateway.js";
import { IntegrationsConfigSchema } from "./schema-integrations.js";
import { MemoryConfigSchema } from "./schema-memory.js";
import { MessagesConfigSchema } from "./schema-messages.js";
import { ModelsConfigSchema } from "./schema-models.js";
import { MonitoringConfigSchema } from "./schema-observability.js";
import { ProvidersConfigSchema } from "./schema-providers.js";
import { SchedulerConfigSchema } from "./schema-scheduler.js";
import { SecurityConfigSchema } from "./schema-security.js";

// ---------------------------------------------------------------------------
// Section schema lookup
// ---------------------------------------------------------------------------

/**
 * Maps config section names to their Zod schema objects.
 */
const SECTION_SCHEMAS: Record<string, z.ZodType> = {
  agents: PerAgentConfigSchema,
  channels: ChannelConfigSchema,
  memory: MemoryConfigSchema,
  security: SecurityConfigSchema,
  routing: RoutingConfigSchema,
  daemon: DaemonConfigSchema,
  scheduler: SchedulerConfigSchema,
  gateway: GatewayConfigSchema,
  integrations: IntegrationsConfigSchema,
  monitoring: MonitoringConfigSchema,
  browser: BrowserConfigSchema,
  models: ModelsConfigSchema,
  providers: ProvidersConfigSchema,
  messages: MessagesConfigSchema,
  approvals: ApprovalsConfigSchema,
};

// ---------------------------------------------------------------------------
// Full schema cache
// ---------------------------------------------------------------------------

let fullSchemaCache: Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert the AppConfig schema (or a specific section) to JSON Schema.
 *
 * When called without arguments, returns the full AppConfig JSON Schema
 * (cached after first call). When called with a section name, returns the
 * JSON Schema for that section only (not cached -- section schemas are small).
 *
 * @param section - Optional section name (e.g., "agent", "gateway")
 * @returns JSON Schema object
 * @throws Error if section name is not recognized
 *
 * @example
 * const full = getConfigSchema(); // full AppConfig schema
 * const agent = getConfigSchema("agent"); // agent section only
 */
export function getConfigSchema(section?: string): Record<string, unknown> {
  if (section !== undefined) {
    const sectionSchema = SECTION_SCHEMAS[section];
    if (!sectionSchema) {
      throw new Error(`Unknown config section: ${section}`);
    }
    return z.toJSONSchema(sectionSchema, { reused: "inline", unrepresentable: "any" }) as Record<string, unknown>;
  }

  if (!fullSchemaCache) {
    fullSchemaCache = z.toJSONSchema(AppConfigSchema, {
      reused: "inline",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  }

  return fullSchemaCache;
}

/**
 * Get the list of available config section names.
 *
 * Useful for agents to discover which sections can be queried individually.
 *
 * @returns Array of section name strings
 */
export function getConfigSections(): string[] {
  return Object.keys(SECTION_SCHEMAS);
}
