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
import { createMatrixPlugin, type MatrixPluginHandle } from "@comis/channels";
import { createSsrfGuardedFetcher } from "@comis/skills";
import type {
  Attachment,
  ChannelPort,
  ComisLogger,
  NormalizedMessage,
  NormalizedReaction,
} from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import {
  createMatrixEmulator,
  startLoopbackRedirectTarget,
  type LoopbackRedirectTarget,
  type MatrixEmulator,
} from "../../emulators/matrix/matrix-emulator.js";

const BOT = "@bot:hs.test";
const ALICE = "@alice:hs.test";
const BOB = "@bob:hs.test";
const GROUP_ROOM = "!group:hs.test";
const DM_ROOM = "!dm:hs.test";
const ENC_ROOM = "!encrypted:hs.test";

/** A UUID (the NormalizedMessage `id` shape — `z.guid()`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Stack {
  emu: MatrixEmulator;
  plugin: MatrixPluginHandle;
  adapter: ChannelPort;
  received: NormalizedMessage[];
  stateDir: string;
  logger: ComisLogger;
  /** The loopback homeserver origin (`http://127.0.0.1:<port>`) — the trusted fetch origin. */
  apiRoot: string;
}

const stacks: Stack[] = [];
const redirectTargets: LoopbackRedirectTarget[] = [];
afterEach(async () => {
  // Stop the ADAPTER first (halts the /sync loop) THEN the emulator, so the
  // client is not still polling a closing server; then drop the temp stateDir.
  while (stacks.length > 0) {
    const stack = stacks.pop()!;
    await stack.adapter.stop().catch(() => undefined);
    await stack.emu.stop().catch(() => undefined);
    rmSync(stack.stateDir, { recursive: true, force: true });
  }
  // Close any stand-in CDN listeners started for the cross-host redirect proof.
  while (redirectTargets.length > 0) {
    await redirectTargets.pop()!.stop().catch(() => undefined);
  }
});

/**
 * Build the offline Matrix stack: the loopback emulator + the REAL plugin pointed
 * at it (`allowPrivateHomeserver: true` — the SEC-01 opt-in). An `onMessage`
 * handler auto-replies "echo: <text>" back to the inbound room. The adapter is
 * NOT started here — the caller starts it (so a backlog inject can precede the
 * initial `/sync`).
 *
 * `e2ee: true` flips the real crypto path on (the adapter bootstraps the rust
 * crypto store before `/sync`), so the emulator must answer the crypto-startup
 * key endpoints or the client cannot reach sync-ready. `echo: false` makes the
 * handler capture-only (no auto-reply) — used by the decrypt-degrade edge so an
 * empty outbound oracle is an honest "the bot sent no garbage" assertion rather
 * than being masked by an echo of the synthesized system note.
 */
async function buildStack(opts?: {
  allowMode?: "allowlist" | "open";
  allowFrom?: string[];
  e2ee?: boolean;
  echo?: boolean;
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
    // E2EE needs a stable deviceId — the rust crypto store keys its device
    // identity on it, and initRustCrypto refuses a client with an unknown device.
    // A real e2ee bot configures channels.matrix.deviceId for exactly this reason.
    ...(opts?.e2ee === true ? { e2ee: true, deviceId: "DEVICETEST1" } : {}),
  });
  const adapter = plugin.adapter;

  const echo = opts?.echo ?? true;
  adapter.onMessage(async (msg) => {
    received.push(msg);
    if (echo) await adapter.sendMessage(msg.channelId, `echo: ${msg.text}`);
  });

  const stack: Stack = { emu, plugin, adapter, received, stateDir, logger, apiRoot };
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

describe("matrix-emulator scenario — inbound reaction through the real adapter (the inbound proof)", () => {
  it("fires onReaction with the reactor's full MXID when a live m.reaction arrives on /sync", async () => {
    // The load-bearing proof: a REAL m.reaction is driven through the loopback
    // homeserver's /sync into the REAL adapter + /sync client. The homeserver's
    // server-side timeline filter must admit m.reaction (the widening) AND the
    // onTimeline reaction branch must route it before the message-only gate, or
    // this stays silent — an outbound-only test would be green while inbound is
    // dead. The SDK parses the wire event and fires RoomEvent.Timeline for it.
    const stack = await buildStack();
    const reactions: NormalizedReaction[] = [];
    stack.adapter.onReaction?.((reaction) => {
      reactions.push(reaction);
    });
    await stack.adapter.start();

    const reactionEventId = stack.emu.injectRoomEvent({
      roomId: GROUP_ROOM,
      sender: ALICE,
      type: "m.reaction",
      content: {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$target:hs.test", key: "👍" },
      },
    });
    expect(reactionEventId).toMatch(/^\$/); // a real minted event id

    await waitUntil(() => reactions.length >= 1, 8000);

    // onReaction fired with the fully-mapped NormalizedReaction.
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toEqual({
      messageId: "$target:hs.test",
      reactorId: ALICE, // the FULL MXID, never a display name
      emoji: "👍",
      channelType: "matrix",
      channelId: GROUP_ROOM,
    });
    // A reaction is not a message: the message handler never saw it (no echo).
    expect(stack.received).toHaveLength(0);
    expect(stack.emu.sentMessages(GROUP_ROOM)).toHaveLength(0);
  });

  it("drops a reaction from a non-allowlisted reactor while admitting an allowlisted one", async () => {
    const stack = await buildStack({ allowMode: "allowlist", allowFrom: [ALICE] });
    const reactions: NormalizedReaction[] = [];
    stack.adapter.onReaction?.((reaction) => {
      reactions.push(reaction);
    });
    await stack.adapter.start();

    // A non-allowlisted reactor → gated out (never reaches the handler).
    stack.emu.injectRoomEvent({
      roomId: GROUP_ROOM,
      sender: BOB,
      type: "m.reaction",
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$t1:hs.test", key: "👎" } },
    });
    // An allowlisted reactor → admitted.
    stack.emu.injectRoomEvent({
      roomId: GROUP_ROOM,
      sender: ALICE,
      type: "m.reaction",
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$t2:hs.test", key: "🎉" } },
    });

    await waitUntil(() => reactions.some((r) => r.reactorId === ALICE), 8000);

    expect(reactions.every((r) => r.reactorId === ALICE)).toBe(true);
    expect(reactions.some((r) => r.reactorId === BOB)).toBe(false);
    expect(reactions.map((r) => r.emoji)).toContain("🎉");
    expect(reactions.map((r) => r.emoji)).not.toContain("👎");
  });
});

describe("matrix-emulator scenario — honest inbound edit + redaction (the tamper-resistant proof)", () => {
  it("surfaces an inbound edit as a NEW event with a replaces pointer, never mutating the prior capture", async () => {
    // The load-bearing history-rewrite proof, end-to-end through the REAL adapter +
    // /sync client: a remote edit must arrive as a NEW normalized event carrying the
    // new content and an advisory pointer to the replaced event — never an in-place
    // rewrite of what the bot already received — so the agent cannot be tricked into
    // acting on a silently-rewritten past. An edit relating to an absent target is
    // driven so the SDK delivers the raw m.replace on RoomEvent.Timeline (no local
    // aggregation), the same timeline path a live homeserver uses.
    const stack = await buildStack();
    await stack.adapter.start();

    // A first message the bot receives and reasons on — the prior context.
    stack.emu.injectRoomMessage({ roomId: GROUP_ROOM, sender: ALICE, body: "the original message" });
    await waitUntil(() => stack.received.length >= 1, 8000);
    const priorSnapshot = JSON.stringify(stack.received[0]);

    // A remote edit arrives as an m.replace relating to a prior event id.
    stack.emu.injectRoomEvent({
      roomId: GROUP_ROOM,
      sender: ALICE,
      type: "m.room.message",
      content: {
        msgtype: "m.text",
        body: "* edited",
        "m.new_content": { msgtype: "m.text", body: "edited" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$orig:hs.test" },
      },
    });
    await waitUntil(
      () => stack.received.some((m) => m.metadata.matrixReplacesEventId === "$orig:hs.test"),
      8000,
    );

    // The edit surfaced as a NEW event carrying the NEW content + the advisory pointer.
    const edit = stack.received.find((m) => m.metadata.matrixReplacesEventId === "$orig:hs.test");
    expect(edit).toBeDefined();
    expect(edit?.text).toBe("edited");
    expect(edit?.id).toMatch(UUID_RE);
    // The prior captured message object was NOT mutated in place (immutable receipt).
    expect(JSON.stringify(stack.received[0])).toBe(priorSnapshot);
    // The edit is a DISTINCT event from the prior one, not a rewrite of it.
    expect(edit?.id).not.toBe(stack.received[0]?.id);
  });

  it("surfaces an inbound redaction as a NEW honest event naming the target with no reconstructed body", async () => {
    const stack = await buildStack();
    await stack.adapter.start();

    stack.emu.injectRoomEvent({
      roomId: GROUP_ROOM,
      sender: ALICE,
      type: "m.room.redaction",
      content: {},
      redacts: "$orig:hs.test",
    });
    await waitUntil(
      () => stack.received.some((m) => m.metadata.matrixRedactsEventId === "$orig:hs.test"),
      8000,
    );

    const redaction = stack.received.find(
      (m) => m.metadata.matrixRedactsEventId === "$orig:hs.test",
    );
    expect(redaction).toBeDefined();
    // A body-free honest marker — the removed content is never reconstructed, and
    // the redacted target id rides in advisory metadata, not in the text body.
    expect(typeof redaction?.text).toBe("string");
    expect(redaction?.text.length).toBeGreaterThan(0);
    expect(redaction?.text).not.toContain("$orig:hs.test");
    expect(redaction?.id).toMatch(UUID_RE);
    // It reaches the message path (not treated as a reaction).
    expect(stack.emu.sentMessages(GROUP_ROOM).some((o) => o.body?.includes("$orig"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2EE-enabled startup + the honest decrypt-degrade edge, end-to-end through the
// REAL adapter's crypto path against the loopback emulator. Starting with
// `e2ee: true` bootstraps the rust crypto store BEFORE `/sync`, and the client's
// crypto layer probes the key endpoints (`/keys/upload`, `/keys/query`, …) as it
// prepares — so the emulator must answer those with valid (if empty) shapes or
// the client never reaches sync-ready. This is EDGE coverage of the already-proven
// crypto seam (the real Megolm round-trip is proven elsewhere with real key
// exchange), not a full crypto server: the endpoints are minimal loopback stubs.
//
// The edge that must be proven honest: an inbound `m.room.encrypted` event the bot
// has no session for must NEVER surface as garbage (the raw ciphertext or the
// SDK's "Unable to decrypt" placeholder) and must NEVER be silently dropped — it
// degrades to a once-per-room system note carrying a secret-free operator hint.
// ---------------------------------------------------------------------------

/** A well-formed-but-undecryptable Megolm ciphertext — the bot holds no session for it. */
const UNDECRYPTABLE_CIPHERTEXT = "AwgAEpABz0PLAINTEXTFREEciphertextTHATcannotDECRYPT1234==";

describe("matrix-emulator scenario — e2ee-enabled startup + honest decrypt degrade (edge)", () => {
  it("starts the real adapter with e2ee enabled against loopback and still round-trips a plaintext message", async () => {
    const stack = await buildStack({ e2ee: true });

    // Sync-ready must be reached: the crypto bootstrap + startClient probe the key
    // endpoints, so start() only resolves ok when the emulator answers them.
    const started = await stack.adapter.start();
    expect(started.ok).toBe(true);

    // A plaintext event in an e2ee-enabled adapter still round-trips (the crypto
    // path does not swallow cleartext room messages).
    stack.emu.injectRoomMessage({
      roomId: GROUP_ROOM,
      sender: ALICE,
      body: "hello over an e2ee-enabled adapter",
    });

    const out = await waitForOutbound(stack.emu, GROUP_ROOM);
    expect(stack.received.some((m) => m.text === "hello over an e2ee-enabled adapter")).toBe(true);
    expect(out.some((o) => o.body === "echo: hello over an e2ee-enabled adapter")).toBe(true);

    // The crypto-startup key endpoints must be ANSWERED by the emulator, not left
    // to fall through to the catch-all safety net. The real adapter's crypto layer
    // publishes device + one-time keys via POST /keys/upload and probes devices via
    // POST /keys/query on startup; if those are unhandled the client cannot complete
    // its key handshake (it retries an unparseable response indefinitely). Asserting
    // they never hit the catch-all is the load-bearing proof the emulator serves the
    // crypto surface with valid shapes.
    const unhandled = stack.emu.unhandledPaths();
    expect(unhandled.some((p) => p.includes("/keys/upload"))).toBe(false);
    expect(unhandled.some((p) => p.includes("/keys/query"))).toBe(false);
  });

  it("degrades an undecryptable m.room.encrypted event to an honest system note, never garbage and never a silent drop", async () => {
    // Capture-only (echo off): the bot must send NOTHING for an event it cannot
    // decrypt, so an empty send oracle is the load-bearing "no garbage out" proof —
    // an echo would otherwise mask it by replaying the synthesized note.
    const stack = await buildStack({ e2ee: true, echo: false });
    const started = await stack.adapter.start();
    expect(started.ok).toBe(true);

    // A live m.room.encrypted event for a session the bot never received. The real
    // crypto backend attempts decryption, fails closed, and the adapter synthesizes
    // the once-per-room degrade note instead of leaking ciphertext.
    stack.emu.injectRoomEvent({
      roomId: ENC_ROOM,
      sender: ALICE,
      type: "m.room.encrypted",
      content: {
        algorithm: "m.megolm.v1.aes-sha2",
        ciphertext: UNDECRYPTABLE_CIPHERTEXT,
        sender_key: "CURVEsenderKEYplaceholderNOTaREALdeviceKEY00",
        session_id: "MEGOLMsessionIDplaceholderUNKNOWNtoTHISbot00",
        device_id: "ALICEDEVICE1",
      },
    });

    // NOT a silent drop: the honest degrade note reached a session.
    await waitUntil(
      () => stack.received.some((m) => m.metadata.matrixSystemNote === true),
      20000,
    );
    const note = stack.received.find((m) => m.metadata.matrixSystemNote === true);
    expect(note).toBeDefined();
    // The note is a synthesized system note, not a room speaker, and carries a
    // non-empty, secret-free operator hint — never the ciphertext.
    expect(note?.senderId).toBe("system");
    expect(note?.channelId).toBe(ENC_ROOM);
    expect((note?.text.length ?? 0)).toBeGreaterThan(0);
    expect(note?.text).not.toContain(UNDECRYPTABLE_CIPHERTEXT);

    // NO garbage: neither the ciphertext nor the SDK's decrypt placeholder ever
    // surfaces as inbound content…
    expect(stack.received.every((m) => !m.text.includes(UNDECRYPTABLE_CIPHERTEXT))).toBe(true);
    expect(stack.received.every((m) => !m.text.includes("Unable to decrypt"))).toBe(true);
    // …and the bot sent nothing at all for the undecryptable event.
    expect(stack.emu.sentMessages(ENC_ROOM)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Inbound media — the whole path composed end-to-end against the emulator:
// the REAL resolver builds the authenticated download URL from the started
// client and drives the REAL SSRF-guarded fetcher. The loopback tie is the
// trusted-fetch-origin allowance (the Matrix analog of Telegram's apiRoot seam,
// which Matrix lacks): the emulator origin is registered as trusted so the
// authed loopback download is validated leniently instead of SSRF-blocked,
// while EVERY other URL stays strictly validated. The bearer is scoped to the
// homeserver host, so it rides the homeserver hop and is DROPPED on a cross-host
// redirect. Encrypted media rides the same fetcher, then decrypts through the
// audited WASM codec before the MIME sniff.
// ---------------------------------------------------------------------------

/** A real 1×1 PNG (magic bytes recognized by file-type) — the plaintext media fixture. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Media byte cap for the resolver + fetcher in these proofs (well above the fixtures). */
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Build the REAL media resolver over the REAL SSRF-guarded fetcher, registering
 * the given loopback origins as trusted fetch origins so the authed loopback
 * download is not SSRF-blocked. Everything else stays strictly validated; the
 * homeserver-scoped bearer + cross-host token-drop are the fetcher's own.
 */
function buildMediaResolver(stack: Stack, trustedFetchOrigins: string[]) {
  const ssrfFetcher = createSsrfGuardedFetcher(
    { maxBytes: MEDIA_MAX_BYTES, trustedFetchOrigins },
    createMockLogger(),
  );
  return stack.plugin.createResolver({
    ssrfFetcher,
    maxBytes: MEDIA_MAX_BYTES,
    logger: createMockLogger(),
    mediaAuthAllowHosts: [],
  });
}

/**
 * Encrypt a payload with the SAME audited WASM codec the resolver decrypts with,
 * yielding the ciphertext plus the encrypted-file record (with the mxc `url`
 * stitched on). Building the fixture through the real codec is what makes the
 * decrypt genuinely end-to-end rather than a hand-rolled cipher.
 */
async function encryptMediaFixture(
  plaintext: Buffer,
): Promise<{ ciphertext: Buffer; fileFor: (mxc: string) => Record<string, unknown> }> {
  const mod = await import("@matrix-org/matrix-sdk-crypto-wasm");
  if (typeof mod.initAsync === "function") await mod.initAsync();
  const enc = mod.Attachment.encrypt(new Uint8Array(plaintext));
  const info = JSON.parse(enc.mediaEncryptionInfo!) as Record<string, unknown>;
  return {
    ciphertext: Buffer.from(enc.encryptedData),
    fileFor: (mxc: string) => ({ url: mxc, ...info }),
  };
}

describe("matrix-emulator scenario — inbound media end-to-end (real resolver + real SSRF fetcher)", () => {
  it("resolves a plaintext attachment through the authenticated download, bearer on the homeserver hop", async () => {
    const stack = await buildStack();
    await stack.adapter.start();

    stack.emu.putMedia("plainpng", PNG_1X1, "image/png");
    const resolver = buildMediaResolver(stack, [stack.apiRoot]);
    const attachment: Attachment = { type: "image", url: "mxc://hs.test/plainpng" };

    const resolved = await resolver.resolve(attachment);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // MIME is sniffed from the resolved bytes; size is the fixed fixture length.
      expect(resolved.value.mimeType).toBe("image/png");
      expect(resolved.value.sizeBytes).toBe(PNG_1X1.length);
      expect(resolved.value.buffer.equals(PNG_1X1)).toBe(true);
    }
    // The homeserver hop IS token-allowed — the bearer reached the authed download.
    expect(stack.emu.downloadAuthorization("plainpng")).toMatch(/^Bearer /);
  });

  it("follows a homeserver 307 to a cross-host CDN and DROPS the access token on that hop", async () => {
    const stack = await buildStack();
    await stack.adapter.start();

    // The stand-in CDN is a DISTINCT host (localhost) from the homeserver (127.0.0.1);
    // it serves the bytes and records whether the redirect hop carried a bearer.
    const cdn = await startLoopbackRedirectTarget({ bytes: PNG_1X1, contentType: "image/png" });
    redirectTargets.push(cdn);
    stack.emu.putMediaRedirect("cdnpng", `${cdn.origin}/download/blob`);

    // BOTH loopback origins are trusted so both hops are reachable; the token-drop
    // is enforced INDEPENDENTLY by the fetcher's host-scoped auth allowance.
    const resolver = buildMediaResolver(stack, [stack.apiRoot, cdn.origin]);
    const attachment: Attachment = { type: "image", url: "mxc://hs.test/cdnpng" };

    const resolved = await resolver.resolve(attachment);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.mimeType).toBe("image/png");
      expect(resolved.value.buffer.equals(PNG_1X1)).toBe(true);
    }
    // The redirect WAS followed to the CDN (it served the bytes)…
    expect(cdn.requestCount()).toBe(1);
    // …and the CDN hop carried NO Authorization (token dropped cross-host), while
    // the homeserver hop DID carry the bearer.
    expect(cdn.authorizationSeen()).toBeUndefined();
    expect(stack.emu.downloadAuthorization("cdnpng")).toMatch(/^Bearer /);
  });

  it("decrypts an encrypted-room attachment end-to-end to the original plaintext bytes", async () => {
    const stack = await buildStack();
    await stack.adapter.start();

    const secret = Buffer.from("the original plaintext attachment bytes", "utf8");
    const { ciphertext, fileFor } = await encryptMediaFixture(secret);
    const mxc = "mxc://hs.test/encblob";
    // The emulator hosts the CIPHERTEXT at the media id; the resolver downloads it,
    // then decrypts with the encrypted-file record cached off the inbound event below.
    stack.emu.putMedia("encblob", ciphertext, "application/octet-stream");

    // Drive the mapper's cacheEncryptedFile path: an inbound m.image event whose
    // content.file is the encrypted-file record. Once the message is RECEIVED the
    // mapper has already cached the record (it caches during mapping, before
    // delivery), so the resolver reads it back to decrypt.
    stack.emu.injectRoomEvent({
      roomId: GROUP_ROOM,
      sender: ALICE,
      type: "m.room.message",
      content: { msgtype: "m.image", body: "secret.bin", file: fileFor(mxc) },
    });
    await waitUntil(
      () => stack.received.some((m) => m.attachments.some((a) => a.url === mxc)),
      8000,
    );
    expect(stack.received.some((m) => m.attachments.some((a) => a.url === mxc))).toBe(true);

    const resolver = buildMediaResolver(stack, [stack.apiRoot]);
    const resolved = await resolver.resolve({ type: "image", url: mxc });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // The resolver downloaded ciphertext and decrypted it back to the ORIGINAL bytes.
      expect(resolved.value.buffer.equals(secret)).toBe(true);
    }
    // The encrypted-blob download rode the authed hop (bearer present).
    expect(stack.emu.downloadAuthorization("encblob")).toMatch(/^Bearer /);
  });
});
