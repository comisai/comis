// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/orchestrator.ts`.
 *
 * Asserts shape + identity parity with the `@comis/orchestrator` barrel:
 * the mirror exports the same key set, the sentinel `createChannelManager`
 * is a function (Phase 32 extraction landed the factory at this name), and
 * the mirror re-export is identity-equal (`===`) to the direct import.
 * Catches `prepack.js` bundling regressions and silent re-export shadowing.
 *
 * Phase 40 / Phase C §6.3.5 / COV-09.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorOrchestrator from "./orchestrator.js";
import * as directOrchestrator from "@comis/orchestrator";

describe("comisai/orchestrator mirror file — shape parity with @comis/orchestrator barrel", () => {
  it("exports an identical key set as the @comis/orchestrator direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorOrchestrator).sort();
    const directKeys = Object.keys(directOrchestrator).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes createChannelManager as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorOrchestrator as Record<string, unknown>).createChannelManager).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.createChannelManager === @comis/orchestrator.createChannelManager", () => {
    expect((mirrorOrchestrator as Record<string, unknown>).createChannelManager).toBe(
      (directOrchestrator as Record<string, unknown>).createChannelManager,
    );
  });
});
