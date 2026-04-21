// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Schema for a single plugin entry in the plugins configuration.
 *
 * Each plugin can be enabled/disabled, assigned a priority for hook
 * execution order, and given arbitrary plugin-specific configuration.
 */
export const PluginEntrySchema = z.strictObject({
    /** Whether this plugin is active (default: true) */
    enabled: z.boolean().default(true),
    /** Hook execution priority: higher runs first (default: 0, range: -100 to 100) */
    priority: z.number().int().min(-100).max(100).default(0),
    /** Plugin-specific configuration (opaque to the registry) */
    config: z.record(z.string(), z.unknown()).default({}),
  });

/**
 * Schema for the top-level plugins configuration section.
 *
 * Controls the global plugin system toggle and per-plugin settings.
 */
export const PluginsConfigSchema = z.strictObject({
    /** Global plugin system toggle (default: true) */
    enabled: z.boolean().default(true),
    /** Per-plugin configuration keyed by plugin ID */
    plugins: z.record(z.string(), PluginEntrySchema).default({}),
  });

/** Inferred plugins configuration type. */
export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

/** Inferred single plugin entry type. */
export type PluginEntry = z.infer<typeof PluginEntrySchema>;
