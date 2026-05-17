// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/channels.ts`.
 *
 * Asserts shape + identity parity with the `@comis/channels` barrel: the
 * mirror exports the same key set, the sentinel `createTelegramAdapter`
 * is a function, and the mirror re-export is identity-equal (`===`) to
 * the direct import. Catches `prepack.js` bundling regressions and silent
 * re-export shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorChannels from "./channels.js";
import * as directChannels from "@comis/channels";

describe("comisai/channels mirror file — shape parity with @comis/channels barrel", () => {
  it("exports an identical key set as the @comis/channels direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorChannels).sort();
    const directKeys = Object.keys(directChannels).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes createTelegramAdapter as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorChannels as Record<string, unknown>).createTelegramAdapter).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.createTelegramAdapter === @comis/channels.createTelegramAdapter", () => {
    expect((mirrorChannels as Record<string, unknown>).createTelegramAdapter).toBe(
      (directChannels as Record<string, unknown>).createTelegramAdapter,
    );
  });
});
