// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat emulator — the offline round-trip proof (the Google Chat analog of
 * `msteams-emulator.test.ts` / `telegram-emulator.test.ts`).
 *
 * STAGE-B (always runs; no `COMIS_LIVE`, no model, no daemon): the whole Google
 * Chat wire stack is exercised in-process by constructing the REAL production
 * adapter directly and pointing its shipped base-URL DI seams at the emulator —
 * so NO product wiring and NO new daemon egress seam is needed for this proof
 * (unlike Teams, which needed a host-rewrite `fetchImpl`; Google Chat exposes an
 * explicit base URL for every leg):
 *
 *   injected event ──▶ the emulator's fake Pub/Sub subscription
 *                 ──▶ the REAL pull loop (:pull long-poll, base64 decode, dedup)
 *                 ──▶ adapter.handleChatEvent (REAL mapper + card normalizer + allowlist)
 *                 ──▶ onMessage handler replies
 *                 ──▶ adapter.sendMessage (REAL chat.bot token mint + Chat REST)
 *                 ──▶ chatBaseUrl = the emulator ──▶ its per-space oracle.
 *
 * This is the drift tripwire + the security proof in one: the real default-deny
 * allowlist gate, the real Cards v2 default-deny card-action gate, the real
 * per-space send path, and the real Chat REST shape — all offline. The offline leg
 * references NO daemon egress seam at all; it injects the base URLs at
 * construction. The daemon-side egress seam for the full-daemon self-drive is
 * orthogonal and out of this file's scope.
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/scenarios/channels/googlechat-emulator.test.ts
 *
 * @module
 */

import { afterEach, describe, expect, it } from "vitest";
import { createGoogleChatPlugin } from "@comis/channels";
import type { ChannelPort, ComisLogger, NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import {
  createGoogleChatEmulator,
  type GoogleChatEmulator,
} from "../../emulators/googlechat/googlechat-emulator.js";
import {
  makeMessageEvent,
  makeCardClickedEvent,
} from "../../emulators/googlechat/googlechat-payloads.js";

/** The pull subscription resource the adapter is pointed at (loopback via pubsubBaseUrl). */
const SUBSCRIPTION = "projects/test-project/subscriptions/comis-inbound";

interface Stack {
  emu: GoogleChatEmulator;
  adapter: ChannelPort;
  messages: NormalizedMessage[];
}

const stacks: GoogleChatEmulator[] = [];
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.stop();
});

/**
 * Build a full offline Google Chat stack: the emulator + the REAL adapter with its
 * base-URL DI seams (chatBaseUrl / pubsubBaseUrl / tokenUrl) pointed at the
 * emulator origin. An `onMessage` handler auto-replies "echo: <text>" through the
 * real send path. `allowMode` defaults to "open".
 */
async function buildStack(opts?: {
  allowMode?: "allowlist" | "open";
  allowFrom?: string[];
  autoReply?: boolean;
}): Promise<Stack> {
  const emu = createGoogleChatEmulator();
  const { apiRoot } = await emu.start();
  stacks.push(emu);

  const logger: ComisLogger = createMockLogger();
  const messages: NormalizedMessage[] = [];

  const plugin = createGoogleChatPlugin({
    serviceAccountKey: emu.fakeServiceAccountKeyJson(),
    subscriptionName: SUBSCRIPTION,
    allowFrom: opts?.allowFrom ?? [],
    allowMode: opts?.allowMode ?? "open",
    mode: "pubsub",
    logger,
    // The load-bearing DI: EVERY outbound leg (token mint, Pub/Sub pull/ack, Chat
    // REST send) is redirected to the loopback emulator by an explicit base URL —
    // no host-rewrite fetch is needed (unlike Teams' connectorRedirectFetch). The
    // fetchImpl seam is injected as a plain passthrough to complete the four-seam
    // set; the base URLs do all the redirection.
    chatBaseUrl: apiRoot,
    pubsubBaseUrl: apiRoot,
    tokenUrl: `${apiRoot}/token`,
    fetchImpl: (input, init) => fetch(input, init),
  });
  const adapter: ChannelPort = plugin.adapter;

  // Register the handler BEFORE the pull loop opens so a promptly-pulled inbound is
  // never skip-acked for want of a handler.
  adapter.onMessage(async (msg) => {
    messages.push(msg);
    if (opts?.autoReply !== false) {
      await adapter.sendMessage(msg.channelId, `echo: ${msg.text}`);
    }
  });

  const started = await adapter.start();
  expect(started.ok).toBe(true);

  return { emu, adapter, messages };
}

/** Poll the emulator's Chat oracle until an outbound lands in a space (or timeout). */
async function waitForOutbound(
  emu: GoogleChatEmulator,
  space: string,
  timeoutMs = 8000,
): Promise<ReturnType<GoogleChatEmulator["outbound"]>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = emu.outbound(space);
    if (out.length > 0) return out;
    await new Promise((r) => setTimeout(r, 20));
  }
  return emu.outbound(space);
}

/** Poll until `predicate` is true (or timeout); returns the final predicate value. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe("googlechat-emulator scenario — offline inbound→agent→outbound round-trip", () => {
  it("a text MESSAGE event round-trips to the emulator's Chat oracle (echo reply)", async () => {
    const stack = await buildStack();
    const SPACE = "spaces/roundtrip";
    stack.emu.injectInbound(
      makeMessageEvent("hello google", { space: SPACE, user: "users/123" }),
    );

    // The reply landed on the fake Chat API with the exact wire text.
    const out = await waitForOutbound(stack.emu, SPACE);
    expect(stack.messages).toHaveLength(1);
    expect(stack.messages[0]?.text).toBe("hello google");
    expect(stack.messages[0]?.channelId).toBe(SPACE);
    expect(out).toHaveLength(1);
    expect(out[0]?.op).toBe("send");
    expect(out[0]?.text).toBe("echo: hello google");
    // The service-account token mint ran (pubsub-scope pull + chat-scope send).
    expect(stack.emu.tokenMintCount()).toBeGreaterThan(0);
  });

  it("a well-formed CARD_CLICKED routes through the card-action path to a reply", async () => {
    const stack = await buildStack();
    const SPACE = "spaces/cardclick";
    stack.emu.injectInbound(
      makeCardClickedEvent({
        space: SPACE,
        user: "users/approver",
        callback: "signed-cb-blob",
      }),
    );

    // The verified, rendered click normalized to a button-callback message and
    // fanned out to the handler (the synthetic-message path).
    await waitFor(() => stack.messages.length > 0);
    expect(stack.messages).toHaveLength(1);
    expect(stack.messages[0]?.metadata.isButtonCallback).toBe(true);
    expect(stack.messages[0]?.text).toBe("signed-cb-blob");
    // And its reply round-tripped to the Chat oracle.
    const out = await waitForOutbound(stack.emu, SPACE);
    expect(out[0]?.op).toBe("send");
    expect(out[0]?.text).toBe("echo: signed-cb-blob");
  });
});

describe("googlechat-emulator scenario — security gates (unchanged in the emulator setup)", () => {
  it("drops a non-allowlisted sender in allowMode:allowlist (no outbound)", async () => {
    const stack = await buildStack({
      allowMode: "allowlist",
      allowFrom: ["users/allowed"],
    });
    const SPACE = "spaces/drop";
    stack.emu.injectInbound(
      makeMessageEvent("let me in", { space: SPACE, user: "users/not-allowed" }),
    );

    // The adapter drops at the allowlist gate and ACKS (resolves) — wait for the
    // ack, then assert nothing was delivered or sent (no infinite redelivery).
    await waitFor(() => stack.emu.ackedCount() > 0);
    expect(stack.messages).toHaveLength(0);
    expect(stack.emu.outbound(SPACE)).toHaveLength(0);
  });

  it("default-denies an unrendered-method card click (no message, no reply)", async () => {
    const stack = await buildStack();
    const SPACE = "spaces/unrendered";
    stack.emu.injectInbound(
      makeCardClickedEvent({
        space: SPACE,
        user: "users/approver",
        // A method the bot never rendered — the default-deny drop path.
        invokedFunction: "attacker.arbitrary.method",
        callback: "signed-cb-blob",
      }),
    );

    // The card-action gate drops the unrendered method and ACKS (resolves).
    await waitFor(() => stack.emu.ackedCount() > 0);
    expect(stack.messages).toHaveLength(0);
    expect(stack.emu.outbound(SPACE)).toHaveLength(0);
  });
});
