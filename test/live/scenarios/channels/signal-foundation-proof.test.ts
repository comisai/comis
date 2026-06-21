// SPDX-License-Identifier: Apache-2.0
/**
 * CHAN2-02 — THE FOUNDATION-PROOF (Phase 209, Plan 07 — the milestone's
 * foundation capstone).
 *
 * The load-bearing claim of this milestone is that the telegram-first
 * channel-emulation harness GENERALIZES: a SECOND channel (Signal, channel #2)
 * drives the SAME `chan send`/`react`/`explain` flow green, the SAME HARD
 * dual-oracle cross-check holds, and — the strongest evidence — the EXPENSIVE
 * parts of the foundation (`assert/channel-trace.ts` the dual oracle +
 * `harness/chanlive-handle.ts` the per-channel handle) needed ZERO change. This
 * scenario IS that proof.
 *
 * It mirrors `telegram-delivery-roundtrip.test.ts`'s Stage-B / Stage-C split
 * VERBATIM (the 204/205 lineage):
 *
 *   - Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO real model): proves
 *     the wiring STRUCTURE deterministically —
 *       (a) the HARD dual-oracle cross-check (`assertChannelTrace`, 205-01)
 *           PASSES on wire==`delivery_mirror.text` and THROWS on a deliberate
 *           mismatch, using the REAL `createSignalEmulator()` as the channel
 *           oracle (it satisfies the structural `{ lastBotReply(chat): text? }`
 *           subset the dual oracle reads — the FOUNDATION-PROOF PASS: the
 *           highest-value HARD assertion is REUSED UNCHANGED, channel-agnostic);
 *       (b) the section-3A.4 caps contract — `signalCaps` reconciles against the
 *           REAL Signal adapter `CAPABILITIES` (`buttons:false` / `reactions:true`);
 *       (c) the honest `tap`-degrade — `chan --channel signal tap` exits a
 *           DISTINCT non-zero (`unsupported_on_channel`) BEFORE any POST (the
 *           section-3A.4 / I5 leg, via the 209-06 caps gate), `react` is NOT
 *           gated (Signal supports reactions);
 *       (d) the `injectReaction` wire-effect — a `SignalEnvelope` reaction frame
 *           is emitted on the SSE stream (the react FLOW has a real wire effect).
 *
 *   - Stage-C (describe.skipIf(!isLive), COMIS_LIVE, a reachable keyless model)
 *     is the agent-authored round-trip (added in Task 2): `startRig({channel:
 *     "signal"})` boots an isolated daemon pointed at the SignalEmulator (via
 *     `channels.signal.baseUrl`), `chan --channel signal send` round-trips, and
 *     `chan --channel signal explain` works. SKIPPED (skip != fail) without
 *     COMIS_LIVE.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/signal-foundation-proof.test.ts
 *   Stage-C (the agent round-trip, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/signal-foundation-proof.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertChannelTrace, readMirrorText } from "../../assert/channel-trace.js";
import { createSignalEmulator } from "../../emulators/signal/signal-emulator.js";
import { signalCaps, SIGNAL_MAX_MESSAGE_CHARS } from "../../emulators/signal/signal-caps.js";
import {
  parseArgs,
  contextFromParsed,
  runVerb,
  exitCodeFor,
  VerbFailure,
  type ChanliveHandle,
  type VerbContext,
} from "../../bin/chan.js";

const isLive = !!process.env["COMIS_LIVE"];

/**
 * The Signal chat the emulator keys on (a bare recipient — the DM form). The
 * SignalEmulator's per-chat oracle keys on this STRING (vs Telegram's numeric
 * chatId). The dual oracle's `chat: { chatId }` is the channel-agnostic numeric
 * identifier; the closure in {@link asChannelOracle} binds this string so the
 * SignalEmulator's recorded outbound is what the cross-check reads.
 */
const SIGNAL_CHAT = "+15555550111";

// Tmp dirs created per DB-using Stage-B test — cleaned up after each.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Allocate a fresh tmp dir + file DB path (registered for cleanup). */
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "signal-fp-"));
  tmpDirs.push(dir);
  return join(dir, "memory.db");
}

/**
 * Create the delivery_mirror table with the REAL schema (the Comis half of the
 * dual oracle — `readMirrorText` reads `delivery_mirror.text WHERE session_key`),
 * channel-neutral: the `channel_type` column carries `signal` here but the
 * cross-check reads it the same for any channel (`channel-trace.ts:76`).
 */
function freshMirrorDb(): string {
  const dbPath = freshDbPath();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE delivery_mirror (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      text TEXT NOT NULL,
      media_urls TEXT NOT NULL DEFAULT '[]',
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'agent',
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'acknowledged')),
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE UNIQUE INDEX idx_dm_idempotency ON delivery_mirror(idempotency_key);
  `);
  db.close();
  return dbPath;
}

/**
 * INSERT a delivery_mirror fixture row for `signal` (the MIRROR half — the Comis
 * oracle the cross-check compares the wire against). `readMirrorText` keys on
 * `session_key` only (the dual oracle is channel-agnostic by design).
 */
function insertSignalMirrorRow(
  dbPath: string,
  row: { id: string; sessionKey: string; text: string; idempotencyKey: string },
): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO delivery_mirror
         (id, session_key, text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
       VALUES (?, ?, ?, '[]', 'signal', ?, 'agent', ?, 'acknowledged', ?)`,
    ).run(row.id, row.sessionKey, row.text, SIGNAL_CHAT, row.idempotencyKey, 1000);
  } finally {
    db.close();
  }
}

/**
 * Adapt the REAL `SignalEmulator` (string-keyed `lastBotReply(chat: string)`) to
 * the dual oracle's structural subset (`lastBotReply(chat: { chatId }): text?`).
 * The cross-check is channel-agnostic — it reads ONLY `.text` off whatever
 * `lastBotReply` returns; this thin closure binds the fixed Signal chat string
 * so the SignalEmulator's recorded outbound is what the cross-check sees. This
 * is the FOUNDATION-PROOF PASS in action: the dual oracle needs NO Signal-
 * specific edit — a structural adapter at the call site suffices.
 */
function asChannelOracle(emulator: {
  lastBotReply(chat: string): { text?: string } | undefined;
}): { lastBotReply(chat: { chatId: number }): { text?: string } | undefined } {
  return { lastBotReply: () => emulator.lastBotReply(SIGNAL_CHAT) };
}

/**
 * Record a `send` outbound on the running SignalEmulator by POSTing the EXACT
 * JSON-RPC `send` the real adapter sends to the loopback `/api/v1/rpc`
 * (`signalRpcRequest("send", { recipient:[chat], message })`,
 * signal-adapter.ts:237). The emulator records a `RecordedOutbound { method:
 * "send", messageId:<timestamp>, text }` the dual oracle reads as
 * `lastBotReply(chat).text`. The SAME wire path the live adapter drives — no
 * daemon, no product change. Awaits the POST so the oracle is seeded before the
 * cross-check.
 */
async function recordSendOnEmulator(apiRoot: string, chat: string, text: string): Promise<void> {
  const res = await fetch(`${apiRoot}/api/v1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "send",
      params: { recipient: [chat], message: text },
    }),
  });
  if (!res.ok) {
    throw new Error(`emulator /api/v1/rpc send returned ${res.status} — the outbound was not recorded`);
  }
}

/** A recording fake fetch for the caps-gate / react units (the 207 shape). */
function recordingFetch(script: (url: string) => { status?: number; body?: unknown } = () => ({})): {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ method, url, body: parsedBody });
    const { status = 200, body = { ok: true } } = script(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** A fake Signal handle (no real rig) for the caps-gate / react dispatch units. */
function fakeSignalHandle(over: Partial<ChanliveHandle> = {}): ChanliveHandle {
  return {
    channel: "signal",
    controlEndpoint: "http://127.0.0.1:1",
    rigControlEndpoint: "http://127.0.0.1:1",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayToken: "test-token-0000000000000000000000000000",
    chatId: 424242,
    dataDir: "/tmp/does-not-exist",
    memoryDbPath: "/tmp/does-not-exist/memory.db",
    ...over,
  };
}

/** A parsed SSE envelope (the reaction-frame shape the wire-effect test reads). */
interface SseEnvelope {
  dataMessage?: {
    reaction?: { emoji?: string; targetSentTimestamp?: number };
    message?: string;
  };
}

/**
 * Open the SSE `/api/v1/events` stream, run `inject` (which emits frames), and
 * collect the parsed `event: receive` envelopes for a brief bounded window (so
 * the test never hangs).
 */
async function collectSseFrames(url: string, inject: () => void): Promise<SseEnvelope[]> {
  const frames: SseEnvelope[] = [];
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body?.getReader();
  if (!reader) return frames;
  const decoder = new TextDecoder();
  // Inject AFTER the stream is open so the frames are emitted (not queued).
  inject();
  const start = Date.now();
  let buffer = "";
  while (Date.now() - start < 1500) {
    const readPromise = reader.read();
    const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), 300),
    );
    const { done, value } = await Promise.race([readPromise, timeout]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const block of buffer.split("\n\n")) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        try {
          frames.push(JSON.parse(dataLine.slice("data: ".length)) as SseEnvelope);
        } catch {
          // ignore non-JSON keep-alive frames
        }
      }
    }
    buffer = "";
    if (frames.length >= 2) break;
  }
  controller.abort();
  return frames;
}

// ---------------------------------------------------------------------------
// Stage-B — the foundation-proof STRUCTURE (deterministic, no daemon/model)
// ---------------------------------------------------------------------------

describe("CHAN2-02 Stage-B — the Signal foundation-proof structure (no COMIS_LIVE)", () => {
  it("the HARD dual-oracle cross-check (assertChannelTrace) PASSES on wire==mirror and THROWS on a mismatch — REUSED UNCHANGED on the SignalEmulator (the foundation-proof PASS)", async () => {
    const dbPath = freshMirrorDb();
    const emulator = createSignalEmulator();
    const { apiRoot } = await emulator.start();
    try {
      // Record a `send` outbound on the REAL SignalEmulator (the channel oracle)
      // via the EXACT JSON-RPC `send` wire path the live adapter drives.
      const wireText = "the Signal reply on the wire";
      // RED: the SignalEmulator wire-recording seam is not yet driven — the
      // HARD dual-oracle cross-check must THROW (no false green) until GREEN
      // wires the send-recording path. Proves the cross-check has real teeth.
      void apiRoot;
      void recordSendOnEmulator;

      // Seed the matching delivery_mirror row (the Comis oracle).
      insertSignalMirrorRow(dbPath, {
        id: "m1",
        sessionKey: "s",
        text: wireText,
        idempotencyKey: "s:hash:1",
      });

      // Agreement -> resolves (the SignalEmulator's wire bytes == delivery_mirror.text).
      await expect(
        assertChannelTrace({
          emulator: asChannelOracle(emulator),
          chat: { chatId: 424242 },
          memoryDbPath: dbPath,
          sessionKey: "s",
        }),
      ).resolves.toBeUndefined();

      // Disagreement -> a HARD throw (Comis thinks it sent X but the wire shows Y).
      insertSignalMirrorRow(dbPath, {
        id: "m2",
        sessionKey: "s2",
        text: "a DIFFERENT Comis-recorded reply",
        idempotencyKey: "s2:hash:1",
      });
      await expect(
        assertChannelTrace({
          emulator: asChannelOracle(emulator), // wire is still `wireText`
          chat: { chatId: 424242 },
          memoryDbPath: dbPath,
          sessionKey: "s2",
        }),
      ).rejects.toThrow(/dual-oracle/);

      // readMirrorText is the Comis half the live cross-check reads (channel-neutral).
      expect(readMirrorText(dbPath, "s")).toBe(wireText);
    } finally {
      await emulator.stop();
    }
  });

  it("the section-3A.4 caps contract holds: signalCaps reconciles against the REAL Signal adapter CAPABILITIES (buttons:false / reactions:true)", async () => {
    // Import the adapter's REAL declared capabilities (the reconciliation TARGET)
    // — the lazy factory reads the module-local CAPABILITIES with no network.
    const { createSignalPlugin } = await import("@comis/channels");
    const { createMockLogger } = await import("../../../support/mock-logger.js");
    const caps = createSignalPlugin({ baseUrl: "http://127.0.0.1:8080", logger: createMockLogger() })
      .capabilities;

    // The emulator's flat outbound flags reconcile field-by-field with the
    // adapter's nested features — buttons:false is THE honest-degrade trigger.
    expect(signalCaps.outbound.buttons).toBe(false);
    expect(caps.features.buttons).toBe("none");
    expect(signalCaps.outbound.buttons).toBe(caps.features.buttons === "none" ? false : true);
    // reactions:true is the WS1-relevant verb Signal DOES support (chan react works).
    expect(signalCaps.outbound.reactions).toBe(true);
    expect(signalCaps.outbound.reactions).toBe(caps.features.reactions);
    // edits:false — honest degradation (Signal can't edit), reconciled.
    expect(signalCaps.outbound.edits).toBe(false);
    expect(signalCaps.outbound.edits).toBe(caps.features.editMessages);
    // The reconciled message-length limit.
    expect(SIGNAL_MAX_MESSAGE_CHARS).toBe(caps.limits.maxMessageChars);
  });

  it("chan --channel signal tap honest-degrades: a DISTINCT non-zero exit + unsupported_on_channel BEFORE any POST (the section-3A.4 / I5 leg)", async () => {
    const rec = recordingFetch();
    // The threaded channel is signal (the 209-06 caps gate keys on ctx.channel).
    const parsed = parseArgs(["--channel", "signal", "tap", "42", "page=2"]);
    const ctx: VerbContext = {
      ...contextFromParsed(parsed, fakeSignalHandle()),
      controlFetch: rec.fetch,
    };
    const err = await runVerb(parsed.verb as string, parsed.args, ctx).catch((e: unknown) => e);
    // An honest, reason-coded VerbFailure — NOT a success shape ({ tapped }).
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("unsupported_on_channel");
    // Not mislabeled as a dead_handle / no_reply — a caps-gated honest skip.
    expect((err as VerbFailure).kind).not.toBe("dead_handle");
    expect((err as VerbFailure).kind).not.toBe("no_reply");
    // The --json body names the channel + the verb + the missing cap.
    const body = (err as VerbFailure).body;
    expect(body["error"]).toBe("unsupported_on_channel");
    expect(JSON.stringify(body)).toContain("signal");
    expect(JSON.stringify(body)).toMatch(/buttons/);
    // The gate fired BEFORE the POST — NO control fetch was made (not a silent
    // no-op POST, not a fabricated success). The callbacks route was never touched.
    expect(rec.calls).toHaveLength(0);
    // A DISTINCT, non-zero exit code (distinct from dead_handle/no_reply/not-impl).
    expect((err as VerbFailure).exitCode).toBeGreaterThan(0);
    expect((err as VerbFailure).exitCode).not.toBe(exitCodeFor("dead_handle"));
    expect((err as VerbFailure).exitCode).not.toBe(exitCodeFor("no_reply"));
    expect((err as VerbFailure).exitCode).not.toBe(6);
  });

  it("chan --channel signal react is NOT gated (Signal supports reactions) — the verb POSTs the reaction (the react FLOW is unaffected)", async () => {
    const rec = recordingFetch((url) => {
      if (url.includes("/reactions")) return { status: 200, body: { ok: true } };
      return { status: 200, body: [] };
    });
    const parsed = parseArgs(["--channel", "signal", "react", "42", "👍"]);
    const ctx: VerbContext = {
      ...contextFromParsed(parsed, fakeSignalHandle()),
      controlFetch: rec.fetch,
    };
    const result = (await runVerb(parsed.verb as string, parsed.args, ctx)) as Record<string, unknown>;
    // Signal supports reactions -> react works unchanged (the POST happened, honest success).
    expect(result).toEqual({ reacted: { botReplyId: 42, emoji: "👍" } });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url.endsWith("/reactions")).toBe(true);
  });

  it("injectReaction on the SignalEmulator emits a SignalEnvelope reaction frame on the SSE stream (the react FLOW has a real wire effect)", async () => {
    const emulator = createSignalEmulator();
    const { apiRoot } = await emulator.start();
    try {
      // Open the SSE inbound stream and collect frames (the adapter's pull path).
      const frames = await collectSseFrames(`${apiRoot}/api/v1/events`, () => {
        // First inject a message (mint a target timestamp), then react to it.
        const targetTs = emulator.injectMessage(SIGNAL_CHAT, SIGNAL_CHAT, "hello");
        emulator.injectReaction(SIGNAL_CHAT, SIGNAL_CHAT, targetTs, "👍");
      });
      // The reaction frame carries dataMessage.reaction { emoji, targetSentTimestamp }
      // — the EXACT shape the real mapper classifies as a reaction (the wire effect).
      const reactionFrame = frames.find((f) => f?.dataMessage?.reaction?.emoji === "👍");
      expect(reactionFrame, "a reaction envelope was emitted on the SSE stream").toBeDefined();
      expect(typeof reactionFrame?.dataMessage?.reaction?.targetSentTimestamp).toBe("number");
    } finally {
      await emulator.stop();
    }
  });
});

// Stage-C (the COMIS_LIVE agent round-trip) is added in Task 2. The split anchor
// is asserted here so the file always declares both stages (skip != fail).
describe.skipIf(!isLive)("CHAN2-02 Stage-C — the Signal agent round-trip (COMIS_LIVE)", () => {
  it("placeholder until Task 2 wires startRig({channel:'signal'}) — skipped offline (skip != fail)", () => {
    expect(isLive).toBe(true);
  });
});
