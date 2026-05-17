// SPDX-License-Identifier: Apache-2.0
/**
 * Node-backed ClockPort adapter.
 *
 * Sanctioned runtime root (packages/(core|infra)/src/runtime/) per
 * BOOTSTRAP_PATH_PATTERNS at test/support/globals-classifier.ts:92 —
 * Date.now() / new Date() calls inside this file are exempt from the
 * globals architecture rule by classifier, not by allowlist entry.
 *
 * @module
 */
import type { ClockPort } from "@comis/core";

export function createSystemClock(): ClockPort {
  return {
    now: () => Date.now(),
    nowDate: () => new Date(),
  };
}
