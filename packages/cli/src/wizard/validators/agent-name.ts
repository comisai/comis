// SPDX-License-Identifier: Apache-2.0
/**
 * Agent name validator.
 *
 * Enforces naming rules: alphanumeric start, alphanumeric + hyphens body,
 * no trailing hyphen, max 64 characters. These constraints ensure agent
 * names are safe for use as filesystem paths, YAML keys, and identifiers.
 *
 * @module
 */

import type { ValidationResult } from "../types.js";

/** Maximum allowed agent name length. */
const MAX_LENGTH = 64;

/**
 * Pattern: starts with alphanumeric, followed by alphanumeric or hyphens.
 * Does not enforce trailing hyphen (checked separately for a better error message).
 */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

/**
 * Validate an agent name.
 *
 * Returns undefined if valid, or a ValidationResult describing
 * the constraint violation.
 *
 * Rules:
 * - Must not be empty
 * - Must start with a letter or number
 * - Only letters, numbers, and hyphens allowed
 * - Must not end with a hyphen
 * - Maximum 64 characters
 *
 * @param name - The agent name to validate
 */
export function validateAgentName(
  name: string,
): ValidationResult | undefined {
  if (!name || name.trim().length === 0) {
    return {
      message: "Agent name is required.",
      field: "agentName",
    };
  }

  const trimmed = name.trim();

  if (trimmed.length > MAX_LENGTH) {
    return {
      message: "Agent name must be at most 64 characters.",
      hint: `Current length: ${trimmed.length}`,
      field: "agentName",
    };
  }

  if (!NAME_PATTERN.test(trimmed)) {
    return {
      message:
        "Agent name must start with a letter or number and contain only letters, numbers, and hyphens.",
      hint: "Example: my-agent-01",
      field: "agentName",
    };
  }

  if (trimmed.endsWith("-")) {
    return {
      message: "Agent name must not end with a hyphen.",
      field: "agentName",
    };
  }

  return undefined;
}
