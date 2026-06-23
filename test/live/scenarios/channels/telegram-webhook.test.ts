// SPDX-License-Identifier: Apache-2.0
/**
 * AUTO-05 — the (optional) Telegram webhook path: the HARNESS-SIDE secret-token
 * gate + the testable PRODUCT surface today + the HONEST product gap (Phase 208,
 * Plan 04).
 *
 * ⚠ THE AUTO-05 FINDING (HIGH confidence, re-verified at HEAD this session): there
 * is NO Telegram webhook INGESTION route in Comis. 'shouldUseRunner'
 * (packages/channels/src/telegram/telegram-adapter/telegram-webhook.ts:116)
 * returns '!webhookUrl' and merely SKIPS the @grammyjs/runner polling loop when a
 * 'webhookUrl' is configured, with NOTHING replacing it — 'bot.handleUpdate' is
 * driven by NO Comis code and NO HTTP route receives a POSTed Update or checks
 * 'X-Telegram-Bot-Api-Secret-Token'. 'grep -rn webhookCallback packages/' → ZERO;
 * the only reference is a comment: "the host process is expected to drive
 * bot.handleUpdate externally". The boot-time 'validateWebhookSecret'
 * (credential-validator.ts:66) is a FORMAT check only (empty / >256 / non-ASCII),
 * called once at lifecycle boot — it registers no request handler.
 *
 * CONSEQUENCE (the no-false-success absolute): AUTO-05's "a delivered webhook
 * update reaches the agent identically to the polled path" is NOT achievable
 * test-only — the product has no ingestion endpoint to receive the Update or
 * enforce the secret-token gate. This scenario therefore takes **OPTION 2 (the
 * default)**: it asserts AUTO-05's TESTABLE surface — (1) the harness-side
 * secret-token gate (a POST with a wrong/absent token is rejected by the
 * harness's own check), (2) the product-side boot FORMAT validator
 * ('validateWebhookSecret'), (3) the polling-off contract ('shouldUseRunner',
 * asserted against the product SOURCE ground truth since it is not barrel-
 * exported) — and DOCUMENTS the product gap honestly. It NEVER asserts "a webhook
 * update reached the agent" against a route that does not exist. The honest gap
 * is also the DOC-01 (Plan 06) input.
 *
 * (OPTION 1 — a test-first product webhook ingestion route mounting grammy's
 * 'webhookCallback(bot, { secretToken })' — is the deferred alternative; it is a
 * security-sensitive NEW inbound boundary and net-new product scope, NOT taken in
 * this capstone run. See the Plan-04 decision gate + the SUMMARY.)
 *
 * ── THE CI vs COMIS_LIVE SPLIT (the 204-207 pattern — copied VERBATIM) ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO real model): the
 *     deterministic surface. The harness-side secret-token gate (the emulator's
 *     webhook-POST mode → a loopback receiver that enforces the token: correct →
 *     accepted, wrong/absent → rejected); the real 'validateWebhookSecret' boot
 *     FORMAT reject/accept; the 'shouldUseRunner' polling-off contract asserted
 *     against the product source; the honest-gap note; the SEC-02 re-verify + the
 *     zero-product-change git-porcelain guard.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE): the HONEST product-gap leg.
 *     With a real daemon configured for webhook mode there is STILL no ingestion
 *     route, so this leg ASSERTS THE BOUNDARY (the source-confirmed gap + the
 *     polling-off contract) and emits a reason-coded finding — it does NOT and
 *     CANNOT assert "a webhook update reached the agent". A false success here
 *     would be the worst outcome (the no-false-success absolute).
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-webhook.test.ts
 *   Stage-C (the honest product-gap leg, COMIS_LIVE):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-webhook.test.ts
 *
 * (NB: a BARE 'pnpm vitest run test/live/...' resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  '-c test/live/vitest.config.ts'.)
 *
 * TEST-HARNESS — lives under 'test/', never the packages source-tree; ZERO
 * production code change (Option 2).
 *
 * @module
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { validateWebhookSecret } from "@comis/channels";
import {
  createTgEmulator,
  type TgEmulator,
  type ChatRef,
} from "../../emulators/telegram/tg-emulator.js";
import { resetUpdateIdCounter } from "../../emulators/telegram/tg-payloads.js";
import { createWebhookReceiver, type WebhookReceiver } from "../../emulators/telegram/webhook-receiver.js";

const isLive = !!process.env["COMIS_LIVE"];

// The fixed test chat (a fabricated DM id, never a real operator chat).
const TEST_CHAT: ChatRef = { chatId: 424242 };
const FROM = { id: 777, firstName: "Webhooker", username: "webhooker" } as const;
const BOT_TOKEN = "12345:test";
const WEBHOOK_SECRET = "s3cr3t-webhook-token-bbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Stage-B #1 — the HARNESS-SIDE secret-token gate (AUTO-05's gate, harness side)
// ---------------------------------------------------------------------------

describe("AUTO-05 Stage-B — the harness-side secret-token gate (the emulator webhook-POST mode → a loopback receiver)", () => {
  let receiver: WebhookReceiver;
  let emu: TgEmulator;

  beforeEach(async () => {
    resetUpdateIdCounter();
    receiver = await createWebhookReceiver(WEBHOOK_SECRET);
    emu = createTgEmulator({ botToken: BOT_TOKEN, webhook: { url: receiver.url, secret: WEBHOOK_SECRET } });
    await emu.start();
  });

  afterEach(async () => {
    await emu.stop();
    await receiver.stop();
  });

  it("a webhook-POST with the CORRECT X-Telegram-Bot-Api-Secret-Token is accepted; a WRONG and an ABSENT token are BOTH rejected", async () => {
    // CORRECT token → accepted (200), the Update delivered to the gate.
    const okStatus = await emu.postWebhookMessage(TEST_CHAT, FROM, "delivered via webhook");
    expect(okStatus).toBe(200);
    expect(receiver.accepted().length).toBe(1);
    expect((receiver.accepted()[0]!.message as unknown as Record<string, unknown>)["text"]).toBe(
      "delivered via webhook",
    );

    // WRONG token → rejected (401), NOT delivered.
    const wrongStatus = await emu.postWebhookMessage(TEST_CHAT, FROM, "forged (wrong token)", "the-wrong-token");
    expect(wrongStatus).toBe(401);

    // ABSENT token (empty header) → rejected (401), NOT delivered.
    const absentStatus = await emu.postWebhookMessage(TEST_CHAT, FROM, "forged (absent token)", "");
    expect(absentStatus).toBe(401);

    // The gate let through ONLY the correctly-tokened Update; both forgeries blocked.
    expect(receiver.accepted().length).toBe(1);
    expect(receiver.rejectedCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Stage-B #2 — the PRODUCT-side boot FORMAT validator (validateWebhookSecret)
// ---------------------------------------------------------------------------

describe("AUTO-05 Stage-B — validateWebhookSecret (the product boot FORMAT validator, the testable product surface today)", () => {
  it("rejects an EMPTY secret at boot", () => {
    const r = validateWebhookSecret("");
    // GREEN: validateWebhookSecret REJECTS an empty secret (Telegram requires
    // 1-256 chars) — the product boot FORMAT validator, asserted at the real
    // export. This is AUTO-05's testable product surface today.
    expect(r.ok).toBe(false);
  });

  it("rejects a secret LONGER than 256 chars at boot", () => {
    const r = validateWebhookSecret("a".repeat(257));
    expect(r.ok).toBe(false);
  });

  it("rejects a NON-ASCII secret at boot", () => {
    const r = validateWebhookSecret("sécret-with-non-ascii-é");
    expect(r.ok).toBe(false);
  });

  it("ACCEPTS a well-formed ASCII secret (1-256 chars)", () => {
    const r = validateWebhookSecret(WEBHOOK_SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(WEBHOOK_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Stage-B #3 — the polling-off contract (shouldUseRunner) + the HONEST gap,
// asserted against the PRODUCT SOURCE ground truth.
//
// 'shouldUseRunner' is NOT barrel-exported from @comis/channels (the harness
// imports bare-package only, per SEC-02 — never a deep packages source-tree path), so
// its 'return !deps.webhookUrl' contract + the "host process drives
// handleUpdate externally" comment are asserted by reading the REAL product
// source file. This proves polling-off-when-webhookUrl-set + DOCUMENTS the gap
// (no ingestion route at HEAD) against ground truth, with ZERO product change
// and no false "a webhook update reached the agent" claim.
// ---------------------------------------------------------------------------

describe("AUTO-05 Stage-B — shouldUseRunner polling-off + the HONEST product gap (no Telegram webhook ingestion route at HEAD)", () => {
  /** Resolve a packages source-tree file's text (read-only; the gap evidence). */
  function readProductSource(relPath: string): { text: string; repoRoot: string } {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    return { text: readFileSync(resolve(repoRoot, relPath), "utf8"), repoRoot };
  }

  it("shouldUseRunner returns !webhookUrl (polling is OFF when a webhookUrl is set) — asserted against the product source", () => {
    const { text } = readProductSource(
      "packages/channels/src/telegram/telegram-adapter/telegram-webhook.ts",
    );
    // The polling-vs-webhook transport decision: the runner is SKIPPED when a
    // webhookUrl is configured ('return !deps.webhookUrl'). When webhookUrl is
    // set → shouldUseRunner === false → the @grammyjs/runner polling loop does
    // NOT start.
    expect(/export function shouldUseRunner\([^)]*\)\s*:\s*boolean\s*{\s*return\s*!deps\.webhookUrl;?\s*}/s.test(text))
      .toBe(true);
  });

  it("the HONEST gap holds: NOTHING replaces the skipped runner — no ingestion route, no secret-token check (grep webhookCallback packages/ → 0)", () => {
    const { text, repoRoot } = readProductSource(
      "packages/channels/src/telegram/telegram-adapter/telegram-webhook.ts",
    );
    // (a) The source itself documents that the host must drive ingestion — i.e.
    // Comis does NOT. This comment IS the honest-gap evidence. (The comment
    // wraps across two JSDoc lines — "...bot.handleUpdate\n * externally" — so
    // the regex tolerates the whitespace + leading-* continuation between them.)
    expect(/host process is expected to drive bot\.handleUpdate\s+\*?\s*externally/.test(text)).toBe(true);

    // (b) There is NO grammy webhookCallback ingestion primitive mounted anywhere
    // in packages/ — the AUTO-05 finding. 'git grep' over the tracked tree → 0
    // hits (the generic gateway createMappedWebhookEndpoint is a DIFFERENT
    // feature, not the Telegram grammy ingestion path).
    let webhookCallbackHits = "";
    try {
      webhookCallbackHits = execFileSync(
        "git",
        ["grep", "-l", "webhookCallback", "--", "packages/"],
        { cwd: repoRoot, encoding: "utf-8" },
      );
    } catch {
      // 'git grep -l' exits non-zero with no output when there are NO matches —
      // which is EXACTLY the gap we assert. Treat that as "0 hits".
      webhookCallbackHits = "";
    }
    expect(
      webhookCallbackHits.trim(),
      `HONEST GAP regressed: a grammy webhookCallback ingestion route now exists in packages/ (${webhookCallbackHits.trim()}). ` +
        `If this is intended (AUTO-05 Option 1 shipped test-first with the secret-token gate), update this scenario to ` +
        `assert the real product ingestion path (wrong/absent token → rejected, NO inbound row; correct → delivered).`,
    ).toBe("");

    // (c) THE NO-FALSE-SUCCESS NOTE: end-to-end webhook ingestion (a POSTed
    // Update reaching the agent identically to the polled path) is a REAL product
    // boundary that does NOT exist at HEAD. This scenario asserts the HARNESS-side
    // gate + the boot validators only; it never claims a webhook update reached
    // the agent. AUTO-05 is satisfied via Option 2 (the honest gap), not faked.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — SEC-02 re-verify + the zero-product-change git-porcelain guard
// ---------------------------------------------------------------------------

describe("SEC-02 Stage-B — the never-published guard re-verifies + the phase diff is test/-only (zero production code change)", () => {
  it("the SEC-02 never-published invariant holds: no chan/tg comis subcommand + no package.json under test/live", () => {
    // Re-verify the two SEC-02 dimensions a NEW scenario file could plausibly
    // regress, asserted DIRECTLY (no nested-vitest subprocess): the published CLI
    // registers no chan/tg subcommand, and no package.json lives under test/live/**.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();

    // Dimension 3 — the published comis CLI registers no chan/tg subcommand.
    // The quote-char class is built from char codes (0x22 ", 0x27 ', 0x60
    // backtick) so this source file contains NO literal backtick (oxc's template
    // tracking mis-parses a backtick embedded in a regex/comment — avoid it).
    const quoteClass = `[${String.fromCharCode(0x22, 0x27, 0x60)}]`;
    const cliSource = readFileSync(resolve(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    for (const name of ["chan", "tg"] as const) {
      expect(
        new RegExp(String.raw`\.command\(\s*` + quoteClass + name + String.raw`\b`).test(cliSource),
        `SEC-02: the comis CLI must NOT register a "${name}" subcommand (it is a dev/test entry, never published).`,
      ).toBe(false);
    }

    // Dimension 1 — no package.json under test/live/** (a workspace member there
    // would make a fake channel server publishable).
    const liveRoot = resolve(repoRoot, "test/live");
    const offendingPkgJson: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") continue;
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (entry === "package.json") offendingPkgJson.push(relative(repoRoot, abs).split(sep).join("/"));
      }
    };
    walk(liveRoot);
    expect(
      offendingPkgJson,
      `SEC-02: no package.json may live under test/live/** — found: ${offendingPkgJson.join(", ")}`,
    ).toEqual([]);
  });

  it("git status --porcelain shows NO packages source change (the Option-2 zero-production-change premise)", () => {
    // The webhook secret-token CHECK does not exist in the product at HEAD (the
    // AUTO-05 finding) — Option 2 asserts the HARNESS-side gate + the boot
    // validators with ZERO product change. If this fails, a packages source-tree file
    // was touched — i.e. someone took Option 1 (a product ingestion route). That
    // is a SECURITY-SENSITIVE inbound boundary that must land test-first with the
    // secret-token gate + the §2.7 logging matrix + full 'pnpm validate' — STOP
    // and route it through Option 1's gates, not this guard.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    expect(offending, `production source changed (Option 1 territory): ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the HONEST product-gap leg (COMIS_LIVE). NOT an ingestion test —
// there is no ingestion route. This leg re-affirms the boundary against a
// COMIS_LIVE run and emits a reason-coded finding; it CANNOT and does NOT claim
// "a webhook update reached the agent" (the no-false-success absolute).
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("AUTO-05 Stage-C — the HONEST product-gap re-affirmation (COMIS_LIVE; NO ingestion route to drive)", () => {
  it("documents (and does NOT fake) the missing ingestion path: the harness can POST + gate a webhook Update, but no product route ingests it", async () => {
    // Drive the harness-side gate once more under COMIS_LIVE for parity, then
    // emit the HONEST finding. There is deliberately NO daemon boot that ingests
    // the POST — the product has no route, so booting one and asserting a reply
    // would be a FALSE SUCCESS (ACCEPT-01's hard-fail class). The honest outcome
    // is: the gate works on the harness side; product ingestion is a tracked gap
    // (AUTO-05 Option 1, deferred). This is the no-false-success contract.
    resetUpdateIdCounter();
    const receiver = await createWebhookReceiver(WEBHOOK_SECRET);
    const emu = createTgEmulator({ botToken: BOT_TOKEN, webhook: { url: receiver.url, secret: WEBHOOK_SECRET } });
    await emu.start();
    try {
      const status = await emu.postWebhookMessage(TEST_CHAT, FROM, "webhook update (no product route to ingest it)");
      expect(status).toBe(200);
      expect(receiver.accepted().length).toBe(1);
      // The reason-coded honest finding (NOT a faked "update reached the agent").
      // eslint-disable-next-line no-console
      console.warn(
        "[AUTO-05] HONEST GAP: the harness webhook-POST + secret-token gate work, but Comis has NO Telegram " +
          "webhook ingestion route at HEAD (shouldUseRunner skips polling with nothing replacing it; " +
          "grep webhookCallback packages/ → 0). End-to-end webhook ingestion is a tracked product gap " +
          "(AUTO-05 Option 1, deferred) — NOT claimed here.",
      );
    } finally {
      await emu.stop();
      await receiver.stop();
    }
  });
});
