/**
 * Network validators for IP address and bind mode.
 *
 * Validates IPv4 address format (4 octets, each 0-255) and
 * bind mode selection (loopback, lan, custom).
 *
 * @module
 */

import type { ValidationResult } from "../types.js";

/** Valid bind modes for the gateway. */
const VALID_BIND_MODES = new Set(["loopback", "lan", "custom"]);

/** IPv4 address pattern: four groups of 1-3 digits separated by dots. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Validate an IPv4 address string.
 *
 * Checks format (4 dot-separated octets) and numeric range (0-255 per octet).
 * Returns undefined if valid, or a ValidationResult describing the issue.
 *
 * @param ip - The IP address string to validate
 */
export function validateIpAddress(
  ip: string,
): ValidationResult | undefined {
  if (!ip || ip.trim().length === 0) {
    return {
      message: "IP address is required.",
      field: "ipAddress",
    };
  }

  const trimmed = ip.trim();
  const match = IPV4_PATTERN.exec(trimmed);

  if (!match) {
    return {
      message: "Invalid IPv4 address.",
      hint: "Expected format: 192.168.1.1",
      field: "ipAddress",
    };
  }

  // Validate each octet is in range 0-255
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    if (octet > 255) {
      return {
        message: "Invalid IPv4 address.",
        hint: "Each octet must be 0-255.",
        field: "ipAddress",
      };
    }
  }

  return undefined;
}

/**
 * Validate a bind mode selection.
 *
 * Must be one of: "loopback", "lan", "custom".
 * Returns undefined if valid, or a ValidationResult.
 *
 * @param mode - The bind mode string to validate
 */
export function validateBindMode(
  mode: string,
): ValidationResult | undefined {
  if (!VALID_BIND_MODES.has(mode)) {
    return {
      message: "Invalid bind mode.",
      hint: "Must be one of: loopback, lan, custom",
      field: "bindMode",
    };
  }

  return undefined;
}
