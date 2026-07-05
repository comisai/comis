// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix emulator — the offline round-trip proof (the Matrix analog of
 * `signal-foundation-proof.test.ts` / `msteams-emulator.test.ts`).
 *
 * STAGE-B (always runs; no `COMIS_LIVE`, no model, no daemon): the whole Matrix
 * pull stack is exercised in-process by constructing the REAL production plugin
 * and pointing it at the loopback homeserver emulator — NO product wiring and NO
 * client injection is needed, because `homeserverUrl` + `allowPrivateHomeserver`
 * are real config the adapter honors:
 *
 *   emulator /sync (loopback) ──▶ createMatrixPlugin (REAL adapter + /sync client)
 *                            ──▶ watermark guard + MXID speaker gate
 *                            ──▶ onMessage handler replies "echo: <text>"
 *                            ──▶ adapter.sendMessage ──▶ PUT /rooms/{id}/send
 *                            ──▶ the emulator's send oracle.
 *
 * THE LOOPBACK TIE (the SEC-01 opt-in, exercised not bypassed): `homeserverUrl`
 * is SSRF-guarded, so reaching `http://127.0.0.1` REQUIRES
 * `allowPrivateHomeserver: true`. Setting it here deliberately drives the SEC-01
 * private-range relax path end-to-end (cloud-metadata stays blocked); without it
 * the adapter refuses to connect. This is the contrast with Telegram's `apiRoot`
 * seam (a test-only redirect with NO SSRF guard) — Matrix has no such seam.
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/scenarios/channels/matrix-emulator.test.ts
 *
 * @module
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMatrixPlugin } from "@comis/channels";
import type { ChannelPort, ComisLogger, NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import { createMatrixEmulator, type MatrixEmulator } from "../../emulators/matrix/matrix-emulator.js";

const BOT = "@bot:hs.test";
const ALICE = "@alice:hs.test";
const BOB = "@bob:hs.test";
const GROUP_ROOM = "!group:hs.test";
const DM_ROOM = "!dm:hs.test";

/** A UUID (the NormalizedMessage `id` shape — `z.guid()`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Stack {
  emu: MatrixEmulator;
  adapter: ChannelPort;
  received: NormalizedMessage[];
  stateDir: string;
  logger: ComisLogger;
}

const stacks: Stack[] = [];
afterEach(async () => {
  // Stop the ADAPTER first (halts the /sync loop) THEN the emulator, so the
  // client is not still polling a closing server; then drop the temp stateDir.
  while (stacks.length > 0) {
    const stack = stacks.pop()!;
    await stack.adapter.stop().catch(() => undefined);
    await stack.emu.stop().catch(() => undefined);
    rmSync(stack.stateDir, { recursive: true, force: true });
  }
});

/**
 * Build the offline Matrix stack: the loopback emulator + the REAL plugin pointed
 * at it (`allowPrivateHomeserver: true` — the SEC-01 opt-in). An `onMessage`
 * handler auto-replies "echo: <text>" back to the inbound room. The adapter is
 * NOT started here — the caller starts it (so a backlog inject can precede the
 * initial `/sync`).
 */
async function buildStack(opts?: {
  allowMode?: "allowlist" | "open";
  allowFrom?: string[];
}): Promise<Stack> {
  const emu = createMatrixEmulator();
  const { apiRoot } = await emu.start();

  const logger: ComisLogger = createMockLogger();
  const received: NormalizedMessage[] = [];
  const stateDir = mkdtempSync(join(tmpdir(), "matrix-scenario-"));

  const plugin = createMatrixPlugin({
    // The loopback tie: homeserverUrl is SSRF-guarded, so reaching 127.0.0.1
    // REQUIRES allowPrivateHomeserver — this exercises the SEC-01 opt-in path.
    homeserverUrl: apiRoot,
    allowPrivateHomeserver: true,
    userId: BOT,
    accessToken: "emulator-token",
    stateDir,
    allowFrom: opts?.allowFrom ?? [],
    allowMode: opts?.allowMode ?? "allowlist",
    autoJoinOnInvite: true,
    logger,
  });
  const adapter = plugin.adapter;

  adapter.onMessage(async (msg) => {
    received.push(msg);
    await adapter.sendMessage(msg.channelId, `echo: ${msg.text}`);
  });

  const stack: Stack = { emu, adapter, received, stateDir, logger };
  stacks.push(stack);
  return stack;
}

/** Poll the emulator's send oracle until an outbound lands in `roomId` (or timeout). */
async function waitForOutbound(
  emu: MatrixEmulator,
  roomId: string,
  timeoutMs = 8000,
): Promise<ReturnType<MatrixEmulator["sentMessages"]>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = emu.sentMessages(roomId);
    if (out.length > 0) return out;
    await new Promise((r) => setTimeout(r, 20));
  }
  return emu.sentMessages(roomId);
}

/** Wait until `predicate()` holds or the timeout elapses (a settle helper). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("matrix-emulator scenario — real-adapter text round-trip (loopback, SEC-01 opt-in)", () => {
  it("round-trips a plaintext message in a GROUP room: chatType group, full MXID, UUID id, matrixEventId, body + formatted_body", async () => {
    const stack = await buildStack();
    await stack.adapter.start();

    const eventId = stack.emu.injectRoomMessage({
      roomId: GROUP_ROOM,
      sender: ALICE,
      body: "hello room",
    });

    const out = await waitForOutbound(stack.emu, GROUP_ROOM);

    // Inbound reached the real mapper with the correct routing identity.
    expect(stack.received).toHaveLength(1);
    const msg = stack.received[0];
    expect(msg?.channelId).toBe(GROUP_ROOM);
    expect(msg?.chatType).toBe("group");
    expect(msg?.senderId).toBe(ALICE); // the FULL MXID, never a display name
    expect(msg?.text).toBe("hello room");
    expect(msg?.id).toMatch(UUID_RE);
    expect(msg?.metadata.matrixEventId).toBe(eventId);

    // The agent's echo landed on the homeserver with body + sanitized formatted_body.
    expect(out).toHaveLength(1);
    expect(out[0]?.msgtype).toBe("m.text");
    expect(out[0]?.body).toBe("echo: hello room");
    expect(out[0]?.format).toBe("org.matrix.custom.html");
    expect(typeof out[0]?.formatted_body).toBe("string");
    expect(out[0]?.formatted_body).toContain("echo: hello room");
  });

  it("round-trips a plaintext message in a DM room: chatType dm (from m.direct) and the echo lands", async () => {
    const stack = await buildStack();
    await stack.adapter.start();

    stack.emu.injectRoomMessage({
      roomId: DM_ROOM,
      sender: ALICE,
      body: "hello dm",
      direct: true,
    });

    const out = await waitForOutbound(stack.emu, DM_ROOM);

    expect(stack.received).toHaveLength(1);
    expect(stack.received[0]?.chatType).toBe("dm");
    expect(stack.received[0]?.channelId).toBe(DM_ROOM);
    expect(out).toHaveLength(1);
    expect(out[0]?.body).toBe("echo: hello dm");
  });
});

describe("matrix-emulator scenario — watermark guard + speaker gate (the real flow)", () => {
  it("NEVER echoes a backlog (pre-PREPARED) event while it DOES echo the live one", async () => {
    const stack = await buildStack();

    // Backlog is served in the INITIAL /sync (pre-PREPARED) → the watermark guard
    // must drop it. Inject BEFORE start() so it is in the initial batch.
    stack.emu.injectBacklog({
      roomId: GROUP_ROOM,
      sender: ALICE,
      body: "backlog-should-drop",
    });

    await stack.adapter.start();

    // The live event is served on an incremental /sync (post-PREPARED) → admitted.
    stack.emu.injectRoomMessage({
      roomId: GROUP_ROOM,
      sender: ALICE,
      body: "live-should-echo",
    });

    const out = await waitForOutbound(stack.emu, GROUP_ROOM);
    // Give any (erroneous) backlog delivery a chance to appear before asserting.
    await waitUntil(() => stack.received.length >= 1);

    // The backlog event was never delivered nor echoed.
    expect(stack.received.some((m) => m.text === "backlog-should-drop")).toBe(false);
    expect(out.some((o) => o.body === "echo: backlog-should-drop")).toBe(false);

    // The live event round-tripped.
    expect(stack.received.some((m) => m.text === "live-should-echo")).toBe(true);
    expect(out.some((o) => o.body === "echo: live-should-echo")).toBe(true);
    // Exactly one delivery + one echo (the live one).
    expect(stack.received).toHaveLength(1);
    expect(out).toHaveLength(1);
  });

  it("drops a non-allowlisted sender and admits an allowlisted one (the MXID speaker gate)", async () => {
    const stack = await buildStack({ allowMode: "allowlist", allowFrom: [ALICE] });
    await stack.adapter.start();

    // A non-allowlisted sender → dropped (never echoed).
    stack.emu.injectRoomMessage({ roomId: GROUP_ROOM, sender: BOB, body: "let me in" });
    // An allowlisted sender → admitted + echoed.
    stack.emu.injectRoomMessage({ roomId: GROUP_ROOM, sender: ALICE, body: "i am allowed" });

    const out = await waitForOutbound(stack.emu, GROUP_ROOM);

    // Only the allowlisted sender's message was delivered and echoed.
    expect(stack.received.every((m) => m.senderId === ALICE)).toBe(true);
    expect(stack.received.some((m) => m.senderId === BOB)).toBe(false);
    expect(out.some((o) => o.body === "echo: i am allowed")).toBe(true);
    expect(out.some((o) => o.body === "echo: let me in")).toBe(false);
  });
});
