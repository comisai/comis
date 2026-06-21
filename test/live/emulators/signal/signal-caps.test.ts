// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A contract test for the Signal capability descriptor + the §3A.4
 * caps↔adapter reconciliation (the FOUND-03 drift tripwire applied to channel
 * #2), Phase 209 / CHAN2-01.
 *
 * `signal-caps.ts` carries the FLAT emulator `ChannelCaps` (design §3A.4); the
 * real production adapter declares a NESTED `ChannelCapability`
 * (channel-capability.ts: `features{}`/`limits{}`/`replyToMetaKey`). This test
 * is the DRIFT TRIPWIRE: it imports the adapter's OWN declared capabilities from
 * `@comis/channels` (via `createSignalPlugin(...).capabilities`, the exported
 * surface that returns the module-local `CAPABILITIES`) and asserts the
 * overlapping fields reconcile field-by-field. If the adapter ever flips a
 * feature flag (esp. `buttons`) or changes `maxMessageChars`, this test fails
 * LOUDLY — the emulator's caps can never silently drift from the real adapter
 * (threat T-209-07). The KEY Signal difference vs Telegram: the adapter declares
 * `buttons: "none"`, so `signalCaps.outbound.buttons` is `false` (the
 * honest-degrade trigger 209-06 wires into `chan tap`).
 *
 * `@comis/channels` resolves from `dist/` via the live vitest alias, so this
 * reads the REAL built adapter declaration (run `pnpm build` first if stale).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/signal/signal-caps.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSignalPlugin } from "@comis/channels";
import type { ChannelCapability } from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import { signalCaps, SIGNAL_MAX_MESSAGE_CHARS } from "./signal-caps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPS_SOURCE = resolve(HERE, "signal-caps.ts");

/**
 * The adapter's REAL declared capabilities (the reconciliation TARGET). Built
 * via the exported plugin factory — the Signal factory is lazy (it constructs
 * the adapter but touches no network until `.start()`/`activate()`), so a bare
 * construction safely reads the module-local `CAPABILITIES` declaration.
 */
function adapterCapabilities(): ChannelCapability {
  const plugin = createSignalPlugin({
    baseUrl: "http://127.0.0.1:8080",
    logger: createMockLogger(),
  });
  return plugin.capabilities;
}

describe("signal-caps — Signal ChannelCaps descriptor (CHAN2-01 / §3A.4)", () => {
  it("is a flat ChannelCaps for signal over http with the reconciled message limit", () => {
    expect(signalCaps.channel).toBe("signal");
    expect(signalCaps.protocol).toBe("http");
    expect(signalCaps.inbound).toBeDefined();
    expect(signalCaps.outbound).toBeDefined();
    // The reconciled limit lives as a sibling const (the flat shape has no slot).
    expect(SIGNAL_MAX_MESSAGE_CHARS).toBe(65536);
  });

  it("declares the Signal-specific surface: buttons:false (no inline buttons), reactions:true", () => {
    // buttons:false is THE honest-degrade trigger — Signal has no inline
    // buttons, so 209-06 caps-gates `chan tap` to an unsupported_on_channel exit.
    expect(signalCaps.outbound.buttons).toBe(false);
    // reactions:true is the WS1-relevant verb Signal DOES support (chan react works).
    expect(signalCaps.outbound.reactions).toBe(true);
    // Honest degradation: unsupported verbs are represented as false, not omitted.
    expect(signalCaps.outbound.edits).toBe(false);
    expect(signalCaps.outbound.threads).toBe(false);
  });
});

describe("signal-caps — §3A.4 caps↔adapter reconciliation (the drift tripwire)", () => {
  it("reconciles the emulator's flat outbound flags against the adapter's nested features field-by-field", () => {
    const caps = adapterCapabilities();
    const f = caps.features;

    // emulator FLAT outbound  ⇄  adapter NESTED features
    expect(signalCaps.outbound.reactions).toBe(f.reactions); // true
    expect(signalCaps.outbound.edits).toBe(f.editMessages); // false — Signal can't edit
    expect(signalCaps.outbound.deletes).toBe(f.deleteMessages); // true
    expect(signalCaps.outbound.attachments).toBe(f.attachments); // true
    expect(signalCaps.outbound.typing).toBe(f.typing); // true
    expect(signalCaps.outbound.threads).toBe(f.threads); // false

    // emulator buttons:false means the adapter declares the "none" flavour
    // (buttons === "none" ? false : ...). THE honest-degrade trigger.
    expect(f.buttons).toBe("none");
    expect(signalCaps.outbound.buttons).toBe(f.buttons === "none" ? false : true);

    // The reconciled message-length limit.
    expect(SIGNAL_MAX_MESSAGE_CHARS).toBe(caps.limits.maxMessageChars); // 65536

    // The adapter declares NO inbound history-fetch surface.
    expect(f.fetchHistory).toBe(false);
  });

  it("asserts the EXACT adapter values (a drift in any flips this test red)", () => {
    const f = adapterCapabilities().features;
    expect(f).toMatchObject({
      reactions: true,
      editMessages: false,
      deleteMessages: true,
      fetchHistory: false,
      attachments: true,
      typing: true,
      threads: false,
      buttons: "none",
    });
    expect(adapterCapabilities().limits.maxMessageChars).toBe(65536);
  });

  it("documents the not-reconciled-yet inbound-only fields (the adapter has no inbound caps surface)", () => {
    // These emulator-only inbound fields are NOT asserted against the adapter
    // (it declares no inbound capability surface). The reconciliation scope is
    // the overlap only — this test proves they EXIST on the emulator caps,
    // documented as not-reconciled-yet (see the source comment).
    expect(signalCaps.inbound).toHaveProperty("text");
    expect(signalCaps.inbound).toHaveProperty("media");
    expect(signalCaps.inbound).toHaveProperty("reactions");
    // The source explicitly documents the not-reconciled-yet boundary.
    const src = readFileSync(CAPS_SOURCE, "utf8");
    expect(src).toMatch(/not-reconciled-yet/i);
  });
});
