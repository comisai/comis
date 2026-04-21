// SPDX-License-Identifier: Apache-2.0
/**
 * Port number validator.
 *
 * Enforces user-space port range (1024-65535). Ports below 1024
 * require root privileges and are rejected with a clear explanation.
 *
 * @module
 */

import type { ValidationResult } from "../types.js";

/** Minimum allowed port (first non-privileged port). */
const MIN_PORT = 1024;

/** Maximum valid port number. */
const MAX_PORT = 65535;

/**
 * Validate a port number.
 *
 * Accepts string or number input. String values are parsed to integer.
 * Returns undefined if valid, or a ValidationResult describing the issue.
 *
 * Rules:
 * - Must be a number (rejects non-numeric strings)
 * - Must be a whole number (rejects floats)
 * - Must be in range 1024-65535
 *
 * @param value - Port number or string representation
 */
export function validatePort(
  value: string | number,
): ValidationResult | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return { message: "Port must be a number.", field: "port" };
  }

  const num = typeof value === "string" ? Number(value) : value;

  if (typeof value === "string" && value.trim().length === 0) {
    return {
      message: "Port is required.",
      field: "port",
    };
  }

  if (isNaN(num)) {
    return {
      message: "Port must be a number.",
      field: "port",
    };
  }

  if (!Number.isInteger(num)) {
    return {
      message: "Port must be a whole number.",
      field: "port",
    };
  }

  if (num < MIN_PORT) {
    return {
      message:
        "Port must be 1024-65535. Ports below 1024 require root privileges.",
      field: "port",
    };
  }

  if (num > MAX_PORT) {
    return {
      message: "Port must be 1024-65535.",
      field: "port",
    };
  }

  return undefined;
}
