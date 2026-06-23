// SPDX-License-Identifier: Apache-2.0
/**
 * MEDIA-01/02/03 — inbound media routing end-to-end through the REAL grammy
 * adapter (Phase 207, Plan 06 — the scenario that DRIVES the media pipeline on
 * the surface the chat-API structurally cannot reach: there are no media
 * attachments in /v1/chat/completions).
 *
 * An injected voice/photo/document/video/video_note `message` reaches the agent
 * as a `tg-file://{file_id}` attachment (buildAttachments → the NormalizedMessage
 * the agent sees); the emulator's file store + `GET /file/bot<token>/<path>`
 * route serve the EXACT stored bytes; a spoiler / location-or-venue maps to
 * `metadata.hasSpoiler` / `metadata.location` (mapGrammyToNormalized). The byte
 * DOWNLOAD + real transcribe/vision/extract is the Stage-C leg (a keyless daemon
 * SHORT-CIRCUITS to a hint BEFORE downloading — media-handler has no
 * transcriber/extractor without a capability provider).
 *
 * ── THE CI vs COMIS_LIVE SPLIT (the 204/205/206 pattern — copied VERBATIM) ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO real model): the WIRING
 *     proof, deterministic. Per kind, makeMediaUpdate's shape feeds the REAL
 *     buildAttachments (@comis/channels) → a `tg-file://{file_id}` attachment
 *     (NEVER a transcript — Pitfall 2 / CF-3: the keyless handler short-circuits
 *     to a hint before any download). The emulator's file route serves the stored
 *     bytes via a DIRECT fetch (no daemon, no SSRF guard). A spoiler / location /
 *     venue maps to metadata.hasSpoiler / metadata.location through the REAL
 *     mapGrammyToNormalized. The zero-product-change git-porcelain guard
 *     re-asserts ZERO packages source change.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE) boots an isolated daemon with
 *     the mediaLoopbackOverride (Plan 05) so the real SSRF-guarded byte download
 *     reaches the loopback emulator, injects a media message, and asserts the
 *     pipeline ran end-to-end (the agent replied; for a capability-bearing model
 *     the transcript/analysis/extraction is asserted in the tg db / trajectory
 *     ground truth). NO-FALSE-SUCCESS (I5): a keyless model that has no
 *     transcriber/vision/extractor short-circuits to a hint — the pipeline runs
 *     but does NOT transcribe; that is an HONEST reason-coded finding, NEVER a
 *     faked "transcribed". SKIPPED (skip != fail) without COMIS_LIVE.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-media.test.ts
 *   Stage-C (the byte-download + pipeline, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-media.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { buildAttachments, mapGrammyToNormalized } from "@comis/channels";
import type { Message } from "grammy/types";
import {
  makeMediaUpdate,
  makeLocationUpdate,
  makeUser,
  type MediaKind,
} from "../../emulators/telegram/tg-payloads.js";
import { createTgEmulator, type TgEmulator } from "../../emulators/telegram/tg-emulator.js";
import type { BuiltRig } from "../../harness/rig.js";

const isLive = !!process.env["COMIS_LIVE"];

// The fixed test chat the media DMs target + the (human) sender.
const CHAT_ID = 424242;
const FROM = { id: 100, firstName: "Alice" } as const;
const FAKE_BOT_TOKEN = "1234567:emulator-fake-token";

// ---------------------------------------------------------------------------
// Stage-B — the media WIRING proof (deterministic, no daemon, no model)
// ---------------------------------------------------------------------------

describe("MEDIA-01/03 Stage-B — the media update reaches the agent as a tg-file://{file_id} attachment (no transcript)", () => {
  // The per-kind contract: makeMediaUpdate's `message` feeds the REAL
  // buildAttachments, which emits a `tg-file://{file_id}` attachment carrying
  // the SAME file_id — NEVER a transcript (the keyless handler short-circuits to
  // a hint BEFORE download; there is nothing to transcribe at this layer).
  const KINDS: ReadonlyArray<{ kind: MediaKind; attachmentType: string }> = [
    { kind: "voice", attachmentType: "audio" },
    { kind: "photo", attachmentType: "image" },
    { kind: "document", attachmentType: "file" },
    { kind: "video", attachmentType: "video" },
    { kind: "video_note", attachmentType: "video" },
  ];

  for (const { kind, attachmentType } of KINDS) {
    it(`a ${kind} media message yields a tg-file://{file_id} ${attachmentType} attachment via the real buildAttachments (Pitfall 2: NOT a transcript)`, () => {
      const fileId = `file_${kind}_abc123`;
      const update = makeMediaUpdate({
        updateId: 9000,
        messageId: 555,
        chatId: CHAT_ID,
        from: makeUser({ id: FROM.id, firstName: FROM.firstName }),
        kind,
        fileId,
        fileUniqueId: `uniq_${fileId}`,
        ...(kind === "voice" || kind === "video" || kind === "video_note" ? { duration: 3 } : {}),
      });
      const msg = update.message;
      expect(msg, "the media Update carries a message").toBeDefined();

      // The REAL product extractor — the agent sees exactly this attachment set.
      const attachments = buildAttachments(msg as Message);
      expect(attachments.length, "exactly one attachment for a single-kind media message").toBe(1);
      const att = attachments[0]!;
      // The url is tg-file://<fileId> — a DEFERRED-download pointer the agent
      // sees, NOT a transcript (the keyless handler short-circuits to a hint
      // before any download; there is nothing to transcribe at this layer).
      expect(att.url).toBe(`tg-file://${fileId}`);
      expect(att.type).toBe(attachmentType);
      // The attachment is a DEFERRED-download pointer (a hint), NEVER a transcript.
      expect(att.url.startsWith("tg-file://")).toBe(true);
    });
  }
});

describe("MEDIA-02 Stage-B — the file route serves the stored bytes via a DIRECT emulator fetch (no daemon, no SSRF)", () => {
  let emu: TgEmulator;
  let apiRoot: string;

  beforeAll(async () => {
    emu = createTgEmulator({ botToken: FAKE_BOT_TOKEN });
    ({ apiRoot } = await emu.start());
  });

  afterAll(async () => {
    await emu.stop().catch(() => undefined);
  });

  it("GET /file/bot<token>/<file_path> returns the EXACT injected bytes (the deterministic byte-serving proof)", async () => {
    const bytes = Buffer.from("the-exact-voice-clip-bytes-🎙️", "utf8");
    // injectMedia stores the bytes under a minted file_id/file_path + queues the
    // media message; getFile resolves the file_path, the route serves the bytes.
    emu.injectMedia({ chatId: CHAT_ID }, FROM, "voice", bytes, { mimeType: "audio/ogg", duration: 2 });

    // Resolve the stored file_path via getFile (keyed by file_id), then fetch the
    // route DIRECTLY — no daemon, no SSRF guard (the Stage-B byte-serving leg;
    // the SSRF-guarded download is Plan 05's deterministic proof + Stage-C here).
    const updatesRes = await fetch(`${apiRoot}/bot${FAKE_BOT_TOKEN}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 5 }),
    });
    const updatesBody = (await updatesRes.json()) as { result: Array<Record<string, unknown>> };
    const message = updatesBody.result[0]!["message"] as Record<string, unknown>;
    const voice = message["voice"] as Record<string, unknown>;
    const fileId = voice["file_id"] as string;

    const fileRes = await fetch(`${apiRoot}/bot${FAKE_BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    const fileBody = (await fileRes.json()) as { result: { file_path: string; file_size: number } };
    // getFile reports the REAL byte length (not the 204 hardcoded 1024).
    expect(fileBody.result.file_size).toBe(bytes.length);

    const byteRes = await fetch(`${apiRoot}/file/bot${FAKE_BOT_TOKEN}/${fileBody.result.file_path}`);
    const received = Buffer.from(await byteRes.arrayBuffer());
    // The route serves the EXACT injected bytes (byte-for-byte) — the
    // deterministic byte-serving proof (no daemon, no SSRF guard on this leg).
    expect(received.equals(bytes)).toBe(true);
  });
});

describe("MEDIA-03 Stage-B — spoiler / location / venue map to metadata via the real mapGrammyToNormalized (A1)", () => {
  it("has_media_spoiler → metadata.hasSpoiler === true", () => {
    const update = makeMediaUpdate({
      updateId: 9100,
      messageId: 556,
      chatId: CHAT_ID,
      from: makeUser({ id: FROM.id, firstName: FROM.firstName }),
      kind: "photo",
      fileId: "file_spoiler_1",
      fileUniqueId: "uniq_spoiler_1",
      spoiler: true,
    });
    const normalized = mapGrammyToNormalized(update.message as Message, CHAT_ID);
    // has_media_spoiler → metadata.hasSpoiler (message-mapper.ts:142).
    expect(normalized.metadata.hasSpoiler).toBe(true);
  });

  it("a location message → metadata.location carries the lat/lng", () => {
    const update = makeLocationUpdate({
      updateId: 9101,
      messageId: 557,
      chatId: CHAT_ID,
      from: makeUser({ id: FROM.id, firstName: FROM.firstName }),
      location: { latitude: 51.5, longitude: -0.12, horizontalAccuracy: 10 },
    });
    const normalized = mapGrammyToNormalized(update.message as Message, CHAT_ID);
    const loc = normalized.metadata.location as { latitude?: number; longitude?: number } | undefined;
    expect(loc, "metadata.location is set for a location message").toBeDefined();
    expect(loc!.latitude).toBe(51.5);
    expect(loc!.longitude).toBe(-0.12);
  });

  it("a venue message → metadata.location WINS over a bare location (the mapper's else-if precedence)", () => {
    const update = makeLocationUpdate({
      updateId: 9102,
      messageId: 558,
      chatId: CHAT_ID,
      from: makeUser({ id: FROM.id, firstName: FROM.firstName }),
      venue: { latitude: 40.0, longitude: -74.0, title: "The Office", address: "1 Main St" },
    });
    const normalized = mapGrammyToNormalized(update.message as Message, CHAT_ID);
    const loc = normalized.metadata.location as { latitude?: number; longitude?: number; name?: string } | undefined;
    expect(loc, "metadata.location is set for a venue message").toBeDefined();
    expect(loc!.latitude).toBe(40.0);
    expect(loc!.longitude).toBe(-74.0);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — zero production code change (the milestone's load-bearing proof)
// ---------------------------------------------------------------------------

describe("MEDIA Stage-B — the whole phase diff is test/-only (zero production code change)", () => {
  it("git status --porcelain shows NO packages source change (the milestone premise)", () => {
    // The media pipeline (buildAttachments / mapGrammyToNormalized / the resolver)
    // is already wired in packages/channels/src and verified at HEAD — the harness
    // EMITS what it consumes + serves the bytes. If this fails, a product file was
    // touched (the 206 Defect Watch may have fired — see the SUMMARY) — STOP.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    expect(offending, `production source changed: ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the byte-download + real transcribe/vision/extract (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("MEDIA-02 Stage-C — the SSRF-guarded byte download + the real media pipeline (COMIS_LIVE)", () => {
  let built: BuiltRig | undefined;
  let memoryDbPath: string | undefined;

  beforeAll(async () => {
    const { buildRig } = await import("../../harness/rig.js");
    // mediaLoopbackOverride:true → the daemon boots with the Plan-05 setupMedia
    // override so the real SSRF-guarded download reaches the loopback emulator.
    built = await buildRig({ channel: "telegram", model: "keyless", mediaLoopbackOverride: true });
    memoryDbPath = built.memoryDbPath;
  });

  afterAll(async () => {
    if (built) await built.cleanup();
    built = undefined;
    memoryDbPath = undefined;
  });

  /**
   * Count DISTINCT inbound (`role='user'`) lcd_messages rows that ACTUALLY carry
   * a MEDIA ATTACHMENT — the inbound-media-routed oracle (WR-01). Honest about
   * what `lcd_messages` CAN assert, and materially stronger than "some user row
   * exists" (the prior query only filtered `role='user'`, so a regression that
   * dropped the attachment and routed the inbound as a plain text turn would have
   * stayed green — the I5 "the assertion must confirm the real pipeline ran" gap).
   *
   * ── Why the filter is `hasAttachments`, NOT `tg-file://` (a live-verified call) ──
   *
   * The review's suggested `tg-file://` filter does NOT match on the real Stage-C
   * path: with an STT provider PRESENT (local whisper here), the daemon RESOLVES
   * the `tg-file://` pointer at ingest (CompositeResolver routing, scheme=tg-file,
   * attachmentType=audio — confirmed in the daemon log) and CONSUMES it inline; it
   * is NOT persisted as text into `lcd_message_parts`. (The "[Attached: … | url:
   * tg-file://…]" hint text only appears when a preprocessing pipeline is DISABLED
   * — the autonomous-media path — which is not this host's posture.) A live db dump
   * confirmed `lcd_message_parts.metadata LIKE '%tg-file%'` == 0 even though the
   * voice message routed end-to-end and the agent replied about it.
   *
   * What DOES survive into the store is the structural attachment flag: prompt
   * assembly stamps `flags.hasAttachments = true` on the inbound metadata iff
   * `msg.attachments.length > 0` (agent/.../prompt-assembly.ts buildMessageFlags),
   * and that metadata is injected into the inbound user turn as a "## Current
   * Message Context" JSON block persisted in `lcd_message_parts.metadata` (the
   * verbatim text block — core/.../parts-codec.ts). So an attachment-bearing turn
   * is queryable by JOINing the parts and LIKE-matching `hasAttachments` — and a
   * plain TEXT turn carries NO such flag, so it does NOT match (the property WR-01
   * wants). Live-verified: 1 attachment-bearing user row per injected voice turn
   * (`%hasAttachments%` == 1), 0 for a non-attachment turn.
   *
   * This proves the MEDIA ROUTING (the attachment reached the agent's prompt
   * assembly) — NOT a transcript (Pitfall 2 / CF-3): on this keyless+whisper host
   * the STT attempt fails on the synthetic bytes and the handler short-circuits to
   * an honest "couldn't transcribe" reply, exactly as the no-false-success contract
   * requires. The Stage-B legs above separately prove the `tg-file://` pointer
   * itself via the REAL buildAttachments + the byte-serving file route.
   */
  function countInboundMediaRows(dbPath: string): number {
    const db = new Database(dbPath, { readonly: true });
    try {
      const present = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('lcd_messages','lcd_message_parts') GROUP BY 1",
        )
        .all();
      // Both tables must exist for the JOIN-based attachment filter (a partial/old
      // db without lcd_message_parts cannot carry the flag → honest 0).
      if (present.length < 2) return 0;
      // DISTINCT message id: a media turn could emit multiple parts; we count the
      // inbound USER ROW whose injected message-context carries hasAttachments, not
      // parts. Static SQL, no interpolation. Mirrors lcd-fts.ts searchViaLike's
      // metadata LIKE surface.
      return (
        db
          .prepare(
            `SELECT count(DISTINCT m.id) AS c
               FROM lcd_messages m
               JOIN lcd_message_parts p ON p.message_id = m.id
              WHERE m.role = 'user' AND p.metadata LIKE '%hasAttachments%'`,
          )
          .get() as { c: number }
      ).c;
    } finally {
      db.close();
    }
  }

  it(
    "an injected voice message routes through the real adapter→media pipeline and the agent replies (transcript IF the model has STT, else an honest hint — never a faked transcript, I5)",
    async () => {
      const r = built;
      const dbPath = memoryDbPath;
      expect(r, "rig booted").toBeDefined();
      expect(dbPath, "memoryDbPath resolved").toBeDefined();
      if (r === undefined || dbPath === undefined) return;

      // Inject a voice message (real bytes) — the daemon's grammy adapter
      // long-polls it, buildAttachments emits the tg-file:// pointer, and the
      // media handler runs (downloading + transcribing IF a transcriber exists,
      // else short-circuiting to a hint — CF-3). injectMedia returns the inbound id.
      const voiceBytes = Buffer.from("RIFF....WAVEfmt fake-voice-clip-for-stt", "utf8");
      const inboundId = await r.controlClient.injectMedia({
        chatId: r.chat.chatId,
        fromUserId: FROM.id,
        kind: "voice",
        fileBase64: voiceBytes.toString("base64"),
        mimeType: "audio/ogg",
        durationMs: 2000,
      });

      // waitForReply is the SYNC POINT — the agent authored a reply, so the media
      // pipeline ran end-to-end (the attachment reached the agent). An honest
      // no-reply (undefined) means the keyless model is unreachable — NEVER faked.
      const reply = await r.waitForReply(inboundId, 1_500_000);
      expect(
        reply,
        "no agent reply — is a keyless model reachable (ollama on localhost:11434)? (honest no-reply, never fabricated)",
      ).toBeDefined();
      if (reply === undefined) return;

      // The inbound row that CARRIES the tg-file:// media pointer reached the LCD
      // store (the agent saw the ATTACHMENT, not merely some text turn). This
      // proves the media ROUTING — NOT a transcript (Pitfall 2). Whether the bytes
      // were transcribed/seen/extracted is gated behind a capability provider; on a
      // plain keyless model the handler short-circuits to a hint (an HONEST result).
      const inboundRows = countInboundMediaRows(dbPath);
      expect(
        inboundRows,
        "FINDING: no inbound ATTACHMENT-BEARING user row in lcd_messages after the voice inject — the media message did not reach the agent's prompt assembly (a plain-text user row carries NO hasAttachments flag and would NOT match this; check the apiRoot seam / buildAttachments / the inbound metadata injection). NOT a faked green (I5).",
      ).toBeGreaterThanOrEqual(1);
    },
    1_800_000,
  );
});
