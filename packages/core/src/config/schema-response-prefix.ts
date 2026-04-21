// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Response prefix configuration schema.
 *
 * Adds a configurable prefix (or suffix) to every agent response.
 * The template string supports variable interpolation for agent metadata,
 * model info, and conditional sections. An empty template disables the feature.
 *
 * Example template: "{agent.emoji} {model|short}{?thinking: | think}"
 */
export const ResponsePrefixConfigSchema = z.strictObject({
  /** Template string for the prefix; empty string disables the feature */
  template: z.string().default(""),
  /** Where to insert the rendered template relative to the response body */
  position: z.enum(["prepend", "append"]).default("prepend"),
});

export type ResponsePrefixConfig = z.infer<typeof ResponsePrefixConfigSchema>;
