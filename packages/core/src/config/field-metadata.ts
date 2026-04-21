// SPDX-License-Identifier: Apache-2.0
/**
 * Config field metadata extraction for CLI/UI config editors.
 *
 * Converts Zod schemas to a flat array of field metadata, including
 * dot-notation paths, types, defaults, descriptions, and immutability
 * classification. This enables config editors to render forms with
 * proper types, defaults, and read-only indicators.
 *
 * @module
 */

import { AppConfigSchema } from "./schema.js";
import { isImmutableConfigPath } from "./immutable-keys.js";

// ---------------------------------------------------------------------------
// Section schema lookup (mirrors schema-serializer.ts)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { PerAgentConfigSchema, RoutingConfigSchema } from "./schema-agent.js";
import { AutoReplyEngineConfigSchema } from "./schema-auto-reply-engine.js";
import { ChannelConfigSchema } from "./schema-channel.js";
import { DaemonConfigSchema } from "./schema-daemon.js";
import { EmbeddingConfigSchema } from "./schema-embedding.js";
import { EnvelopeConfigSchema } from "./schema-envelope.js";
import { GatewayConfigSchema } from "./schema-gateway.js";
import { IntegrationsConfigSchema } from "./schema-integrations.js";
import { MemoryConfigSchema } from "./schema-memory.js";
import { MonitoringConfigSchema } from "./schema-observability.js";
import { PluginsConfigSchema } from "./schema-plugins.js";
import { QueueConfigSchema } from "./schema-queue.js";
import { SchedulerConfigSchema } from "./schema-scheduler.js";
import { SecurityConfigSchema } from "./schema-security.js";
import { SendPolicyConfigSchema } from "./schema-send-policy.js";
import { StreamingConfigSchema } from "./schema-streaming.js";

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
  plugins: PluginsConfigSchema,
  queue: QueueConfigSchema,
  streaming: StreamingConfigSchema,
  autoReplyEngine: AutoReplyEngineConfigSchema,
  sendPolicy: SendPolicyConfigSchema,
  embedding: EmbeddingConfigSchema,
  envelope: EnvelopeConfigSchema,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata for a single config field.
 */
export interface FieldMetadata {
  /** Dot-notation config path (e.g., "gateway.tls.certPath") */
  path: string;
  /** JSON Schema type (string, number, boolean, object, array) */
  type: string;
  /** Default value if defined */
  default?: unknown;
  /** Description from Zod .describe() */
  description?: string;
  /** Whether this field is immutable at runtime */
  immutable: boolean;
}

// ---------------------------------------------------------------------------
// JSON Schema walker
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  default?: unknown;
  description?: string;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: JsonSchemaNode | boolean;
}

/**
 * Resolve the effective type from a JSON Schema node.
 *
 * Handles direct types, anyOf/oneOf patterns (common with Zod optionals
 * and unions), and enum patterns.
 */
function resolveType(node: JsonSchemaNode): string {
  if (node.type) {
    return Array.isArray(node.type) ? node.type[0] : node.type;
  }

  // anyOf / oneOf — common with Zod optionals (type | null) and unions
  const variants = node.anyOf ?? node.oneOf;
  if (variants) {
    // Find the first non-null type
    for (const v of variants) {
      const t = resolveType(v);
      if (t && t !== "null") {
        return t;
      }
    }
    return "unknown";
  }

  if (node.enum) {
    return "string"; // Zod enums become string enums in JSON Schema
  }

  if (node.const !== undefined) {
    return typeof node.const;
  }

  return "unknown";
}

/**
 * Walk a JSON Schema tree recursively, building dot-notation field metadata.
 *
 * @param node - Current JSON Schema node
 * @param prefix - Current dot-notation path prefix
 * @param results - Accumulator for field metadata entries
 */
function walkSchema(
  node: JsonSchemaNode,
  prefix: string,
  results: FieldMetadata[],
): void {
  const type = resolveType(node);

  // Determine immutability by splitting path into section + key
  const dotIndex = prefix.indexOf(".");
  let immutable: boolean;
  if (dotIndex === -1) {
    // Top-level field — check just the section name
    immutable = isImmutableConfigPath(prefix);
  } else {
    const section = prefix.slice(0, dotIndex);
    const key = prefix.slice(dotIndex + 1);
    immutable = isImmutableConfigPath(section, key);
  }

  const entry: FieldMetadata = {
    path: prefix,
    type,
    immutable,
  };

  if (node.default !== undefined) {
    entry.default = node.default;
  }

  // Always include description key (may be undefined)
  entry.description = node.description;

  results.push(entry);

  // Recurse into object properties
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      walkSchema(child, prefix ? `${prefix}.${key}` : key, results);
    }
  }

  // For anyOf/oneOf, walk the object variant's properties
  const variants = node.anyOf ?? node.oneOf;
  if (variants && !node.properties) {
    for (const variant of variants) {
      if (variant.properties) {
        for (const [key, child] of Object.entries(variant.properties)) {
          walkSchema(child as JsonSchemaNode, prefix ? `${prefix}.${key}` : key, results);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract field metadata from the config schema for CLI/UI rendering.
 *
 * When called without arguments, returns metadata for ALL config fields
 * across all sections. When called with a section name, returns only
 * metadata for fields within that section (paths prefixed with `section.`).
 *
 * @param section - Optional section name to filter (e.g., "gateway", "security")
 * @returns Sorted array of field metadata entries
 *
 * @example
 * const all = getFieldMetadata();
 * const gateway = getFieldMetadata("gateway");
 * // gateway[0].path === "gateway.host"
 * // gateway[0].immutable === true
 */
export function getFieldMetadata(section?: string): FieldMetadata[] {
  if (section !== undefined) {
    // Convert section schema to JSON Schema and walk it
    const sectionSchema = SECTION_SCHEMAS[section];
    if (!sectionSchema) {
      return [];
    }

    const jsonSchema = z.toJSONSchema(sectionSchema, {
      reused: "inline",
      unrepresentable: "any",
    }) as JsonSchemaNode;

    const results: FieldMetadata[] = [];
    // Walk properties of the section, prefixing with section name
    if (jsonSchema.properties) {
      for (const [key, child] of Object.entries(jsonSchema.properties)) {
        walkSchema(child, `${section}.${key}`, results);
      }
    }

    return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // Full schema: walk all top-level fields
  const fullJsonSchema = z.toJSONSchema(AppConfigSchema, {
    reused: "inline",
    unrepresentable: "any",
  }) as JsonSchemaNode;

  const results: FieldMetadata[] = [];

  if (fullJsonSchema.properties) {
    for (const [key, child] of Object.entries(fullJsonSchema.properties)) {
      walkSchema(child, key, results);
    }
  }

  return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
