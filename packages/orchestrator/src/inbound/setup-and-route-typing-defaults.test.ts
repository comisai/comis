// SPDX-License-Identifier: Apache-2.0
/**
 * Per-platform typing-refresh defaults for the matrix channel.
 *
 * The matrix adapter tells the homeserver each typing notice lasts 30000ms; the
 * orchestrator must refresh at a shorter interval so a keepalive re-sends before
 * that expiry and the "typing…" indicator never lapses mid-turn.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { PLATFORM_TYPING_DEFAULTS } from "./setup-and-route.js";

describe("PLATFORM_TYPING_DEFAULTS — matrix typing refresh", () => {
  it("resolves matrix to a 25000ms refresh interval", () => {
    expect(PLATFORM_TYPING_DEFAULTS.matrix).toBe(25000);
  });

  it("keeps the matrix refresh below the adapter's 30000ms typing timeout so a keepalive refreshes before expiry", () => {
    expect(PLATFORM_TYPING_DEFAULTS.matrix).toBeLessThan(30000);
  });
});
