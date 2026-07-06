// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A contract test for the Matrix capability descriptor + the caps↔adapter
 * reconciliation (the drift tripwire applied to the Matrix channel).
 *
 * `matrix-caps.ts` carries the FLAT emulator `ChannelCaps`; the real production
 * adapter declares a NESTED `ChannelCapability` (channel-capability.ts:
 * `features{}`/`limits{}`/`replyToMetaKey`). This test is the DRIFT TRIPWIRE: it
 * imports the adapter's OWN declared capabilities from `@comis/channels` (via
 * `createMatrixPlugin(...).capabilities`, the exported surface that returns the
 * module-local `CAPABILITIES`) and asserts the overlapping fields reconcile
 * field-by-field. If the adapter ever flips a feature flag or changes
 * `maxMessageChars`, this test fails LOUDLY — the emulator's caps can never
 * silently drift from the real adapter. Reactions, history fetch, threaded
 * replies, and typing are live (`true`); edits/deletes/attachments stay `false`
 * and `buttons` is `"none"`.
 *
 * `@comis/channels` resolves from `dist/` via the live vitest alias, so this
 * reads the REAL built adapter declaration (run `pnpm build` first if stale).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/matrix/matrix-caps.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createMatrixPlugin } from "@comis/channels";
import type { ChannelCapability } from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import { matrixCaps, MATRIX_MAX_MESSAGE_CHARS } from "./matrix-caps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPS_SOURCE = resolve(HERE, "matrix-caps.ts");

/**
 * The adapter's REAL declared capabilities (the reconciliation TARGET). Built
 * via the exported plugin factory — the Matrix factory is lazy (it constructs
 * the adapter but touches no network/filesystem until `.start()`/`activate()`),
 * so a bare construction safely reads the module-local `CAPABILITIES` declaration.
 */
function adapterCapabilities(): ChannelCapability {
  const plugin = createMatrixPlugin({
    homeserverUrl: "http://127.0.0.1:8008",
    stateDir: "/tmp/matrix-caps-probe",
    allowFrom: [],
    allowMode: "allowlist",
    autoJoinOnInvite: true,
    allowPrivateHomeserver: true,
    logger: createMockLogger(),
  });
  return plugin.capabilities;
}

describe("matrix-caps — Matrix ChannelCaps descriptor", () => {
  it("is a flat ChannelCaps for matrix over http with the reconciled message limit", () => {
    expect(matrixCaps.channel).toBe("matrix");
    expect(matrixCaps.protocol).toBe("http");
    expect(matrixCaps.inbound).toBeDefined();
    expect(matrixCaps.outbound).toBeDefined();
    // The reconciled limit lives as a sibling const (the flat shape has no slot).
    expect(MATRIX_MAX_MESSAGE_CHARS).toBe(32768);
  });

  it("declares the scope: reactions, threads, and typing true, the other outbound rich flags false, buttons none, inbound text true", () => {
    // Reactions send (m.reaction annotation), threaded reply (m.thread relation),
    // and typing (/typing notice) are live; edits/deletes/attachments are not in scope.
    expect(matrixCaps.outbound.reactions).toBe(true);
    expect(matrixCaps.outbound.edits).toBe(false);
    expect(matrixCaps.outbound.deletes).toBe(false);
    expect(matrixCaps.outbound.attachments).toBe(false);
    expect(matrixCaps.outbound.typing).toBe(true);
    expect(matrixCaps.outbound.threads).toBe(true);
    // No button surface here (the adapter declares the "none" flavour).
    expect(matrixCaps.outbound.buttons).toBe(false);
    // Inbound plaintext text (the round-trip surface).
    expect(matrixCaps.inbound.text).toBe(true);
  });
});

describe("matrix-caps — caps↔adapter reconciliation (the drift tripwire)", () => {
  it("reconciles the emulator's flat outbound flags against the adapter's nested features field-by-field", () => {
    const caps = adapterCapabilities();
    const f = caps.features;

    // emulator FLAT outbound  ⇄  adapter NESTED features
    expect(matrixCaps.outbound.reactions).toBe(f.reactions); // true
    expect(matrixCaps.outbound.edits).toBe(f.editMessages); // false
    expect(matrixCaps.outbound.deletes).toBe(f.deleteMessages); // false
    expect(matrixCaps.outbound.attachments).toBe(f.attachments); // false
    expect(matrixCaps.outbound.typing).toBe(f.typing); // true
    expect(matrixCaps.outbound.threads).toBe(f.threads); // true

    // emulator buttons:false means the adapter declares the "none" flavour.
    expect(f.buttons).toBe("none");
    expect(matrixCaps.outbound.buttons).toBe(f.buttons === "none" ? false : true);

    // The reconciled message-length limit.
    expect(MATRIX_MAX_MESSAGE_CHARS).toBe(caps.limits.maxMessageChars); // 32768

    // The adapter declares a real /messages history-fetch surface.
    expect(f.fetchHistory).toBe(true);

    // The reply-target metadata key the adapter carries (the reply seam).
    expect(caps.replyToMetaKey).toBe("matrixEventId");
  });

  it("asserts the EXACT adapter values (a drift in any flips this test red)", () => {
    const f = adapterCapabilities().features;
    expect(f).toMatchObject({
      reactions: true,
      editMessages: false,
      deleteMessages: false,
      fetchHistory: true,
      attachments: false,
      typing: true,
      threads: true,
      buttons: "none",
    });
    expect(adapterCapabilities().limits.maxMessageChars).toBe(32768);
  });

  it("documents the not-reconciled-yet inbound-only fields (the adapter has no inbound caps surface)", () => {
    // These emulator-only inbound fields are NOT asserted against the adapter
    // (it declares no inbound capability surface). The reconciliation scope is
    // the overlap only — this test proves they EXIST on the emulator caps,
    // documented as not-reconciled-yet (see the source comment).
    expect(matrixCaps.inbound).toHaveProperty("text");
    expect(matrixCaps.inbound).toHaveProperty("media");
    expect(matrixCaps.inbound).toHaveProperty("reactions");
    // The source explicitly documents the not-reconciled-yet boundary.
    const src = readFileSync(CAPS_SOURCE, "utf8");
    expect(src).toMatch(/not-reconciled-yet/i);
  });
});
