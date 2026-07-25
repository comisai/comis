// SPDX-License-Identifier: Apache-2.0

/** Parse the documented comma-separated `COMIS_CONFIG_PATHS` value. */
export function parseConfigPaths(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}
