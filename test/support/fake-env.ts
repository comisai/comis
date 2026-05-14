// SPDX-License-Identifier: Apache-2.0
/**
 * FakeEnv: a per-test EnvPort backed by an in-memory record.
 *
 * Matches createSystemEnv shape exactly — only the source differs.
 *
 * Phase 39, PORTS-08.
 *
 * @module
 */
import type { EnvPort } from "@comis/core";

export function createFakeEnv(
  record: Record<string, string | undefined>,
): EnvPort {
  return {
    get: (key) => record[key],
    snapshot: (keys) => {
      const snap: Record<string, string | undefined> = {};
      for (const key of keys) snap[key] = record[key];
      return Object.freeze(snap);
    },
  };
}
