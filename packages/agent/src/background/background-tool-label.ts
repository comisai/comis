// SPDX-License-Identifier: Apache-2.0
import { resolveLabelSpec } from "@comis/core";

/**
 * Return the registered human-facing label for background status prose.
 *
 * Raw capability identifiers remain in structured task metadata. A display
 * label avoids making entropy-shaped identifiers look like credentials when
 * status text crosses persistence and egress secret guards.
 */
export function backgroundToolLabel(toolName: string): string {
  return resolveLabelSpec(toolName).label;
}
