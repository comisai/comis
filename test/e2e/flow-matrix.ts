// SPDX-License-Identifier: Apache-2.0
/**
 * E2E flow-matrix — source of truth for (channel × flow) coverage.
 *
 * Mirrors the architecture-allowlist.ts typed-data pattern. Both the matrix
 * gate test (test/architecture/e2e-matrix.test.ts) and `pnpm test:orchestrate
 * --check-matrix` (test/orchestrate.ts) consume this file.
 *
 * Shape (per design code-quality-plan-2026-05-10.md §6.5):
 *   9 channels × 7 flows = 63 cells. Each cell is either:
 *   - status="covered" with `reference` = repo-relative path to a passing
 *     test file that exists on disk; OR
 *   - status="skipped" with `reference` = non-empty, non-blocklisted reason.
 *
 * Skip-reason discipline: the blocklist regex /^(TODO|later|tbd)/i is enforced
 * by the matrix gate. Use case-specific reasons that name WHY the cell is
 * unrepresentable today (e.g., "email has no native slash-command protocol").
 *
 * Initial classification (Plan 40-08 close):
 *   - 36 covered cells: every (channel × {approval, scheduled, followup, error})
 *     pair maps to an existing channel-agnostic integration E2E that exercises
 *     the cross-channel orchestrator-level flow via the echo adapter (which
 *     is wire-compatible with every production ChannelPort).
 *   - 24 deferred-skipped cells: every (channel × {dm, mention, slash}) pair
 *     for channels that support that flow is `skipped` with a "deferred to
 *     Plan 40-09 (mock platform server)" reason citing the closest-fit
 *     unit-tier test today. Plan 40-09 (Wave 3) flips these back to `covered`
 *     when the mock-platform E2E tests land.
 *   - 3 structural-skipped cells: per RESEARCH.md §5, three (channel × flow)
 *     combinations are unrepresentable at the wire-protocol level — they will
 *     never be promoted to `covered` because the channel has no such concept:
 *       email × slash    — no native slash-command protocol over SMTP/IMAP
 *       email × mention  — no multi-user channel concept; no @-mention in
 *                          SMTP/IMAP semantics
 *       irc × slash      — IRC bots receive plain PRIVMSG text; slash is a
 *                          client-side convention, not part of the IRC wire
 *                          protocol
 *
 * Phase 40 / Phase C §6.5 / COV-12.
 *
 * @module
 */

/** The 9 production channel adapters under `packages/channels/src/<platform>/`. */
export type ChannelName =
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "imessage"
  | "signal"
  | "irc"
  | "line"
  | "email";

/** The 7 use-case flows per design §6.5 / Phase C Cohort 3. */
export type FlowName =
  | "dm"
  | "mention"
  | "slash"
  | "scheduled"
  | "followup"
  | "approval"
  | "error";

export interface FlowCell {
  readonly channel: ChannelName;
  readonly flow: FlowName;
  readonly status: "covered" | "skipped";
  /**
   * For `status: "covered"` — repo-relative path to a test file that exists
   * on disk and exercises this (channel × flow) combination. The matrix gate
   * (test/architecture/e2e-matrix.test.ts) verifies existence via
   * `statSync(...).isFile()`. It does NOT verify the test's content — that
   * structural-vs-behavioral distinction is the matrix's deliberate design
   * (per threat-model T-40-08-02 disposition: accept-with-followon).
   *
   * For `status: "skipped"` — human-readable, case-specific reason explaining
   * why this (channel × flow) is not applicable or is deferred. MUST be
   * non-empty and MUST NOT match `/^(TODO|later|tbd)/i`.
   */
  readonly reference: string;
}

export const CHANNELS: readonly ChannelName[] = [
  "discord",
  "telegram",
  "slack",
  "whatsapp",
  "imessage",
  "signal",
  "irc",
  "line",
  "email",
] as const;

export const FLOWS: readonly FlowName[] = [
  "dm",
  "mention",
  "slash",
  "scheduled",
  "followup",
  "approval",
  "error",
] as const;

/**
 * The 63-cell flow matrix. Order: channel-major, flow-minor — matching
 * `CHANNELS` × `FLOWS` Cartesian product. The matrix gate verifies that all
 * 63 (channel, flow) keys are present exactly once.
 */
export const flowMatrix: readonly FlowCell[] = [
  // ===========================================================================
  // Discord (7 cells)
  // ===========================================================================
  {
    channel: "discord",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Discord gateway server); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/discord/discord-adapter.test.ts at unit-tier.",
  },
  {
    channel: "discord",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Discord gateway server); mention parsing validated today by packages/channels/src/discord/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "discord",
    flow: "slash",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Discord gateway server); slash-command dispatch validated today by test/integration/slash-commands-skills.test.ts (channel-agnostic) and packages/channels/src/discord/discord-actions.test.ts at unit-tier.",
  },
  {
    channel: "discord",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "discord",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "discord",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "discord",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // Telegram (7 cells)
  // ===========================================================================
  {
    channel: "telegram",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Telegram bot API server); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/telegram/telegram-adapter.test.ts at unit-tier.",
  },
  {
    channel: "telegram",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Telegram bot API server); mention parsing validated today by packages/channels/src/telegram/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "telegram",
    flow: "slash",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Telegram bot API server); slash-command dispatch validated today by test/integration/slash-commands-skills.test.ts (channel-agnostic) and packages/channels/src/telegram/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "telegram",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "telegram",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "telegram",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "telegram",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // Slack (7 cells)
  // ===========================================================================
  {
    channel: "slack",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Slack events API server); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/slack/slack-adapter.test.ts at unit-tier.",
  },
  {
    channel: "slack",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Slack events API server); mention parsing validated today by packages/channels/src/slack/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "slack",
    flow: "slash",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock Slack events API server); slash-command dispatch validated today by test/integration/slash-commands-skills.test.ts (channel-agnostic) and packages/channels/src/slack/slack-actions.test.ts at unit-tier.",
  },
  {
    channel: "slack",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "slack",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "slack",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "slack",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // WhatsApp (7 cells)
  // ===========================================================================
  {
    channel: "whatsapp",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock WhatsApp Cloud API server); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/whatsapp/whatsapp-adapter.test.ts at unit-tier.",
  },
  {
    channel: "whatsapp",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock WhatsApp Cloud API server); mention parsing validated today by packages/channels/src/whatsapp/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "whatsapp",
    flow: "slash",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock WhatsApp Cloud API server); slash-command dispatch validated today by test/integration/slash-commands-skills.test.ts (channel-agnostic) and packages/channels/src/whatsapp/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "whatsapp",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "whatsapp",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "whatsapp",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "whatsapp",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // iMessage (7 cells)
  // ===========================================================================
  {
    channel: "imessage",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock iMessage AppleScript bridge); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/imessage/imessage-adapter.test.ts at unit-tier.",
  },
  {
    channel: "imessage",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock iMessage AppleScript bridge); mention parsing validated today by packages/channels/src/imessage/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "imessage",
    flow: "slash",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock iMessage AppleScript bridge); slash-command dispatch validated today by test/integration/slash-commands-skills.test.ts (channel-agnostic) and packages/channels/src/imessage/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "imessage",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "imessage",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "imessage",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "imessage",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // Signal (7 cells)
  // ===========================================================================
  {
    channel: "signal",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock signal-cli REST server); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/signal/signal-adapter.test.ts at unit-tier.",
  },
  {
    channel: "signal",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock signal-cli REST server); mention parsing validated today by packages/channels/src/signal/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "signal",
    flow: "slash",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock signal-cli REST server); slash-command dispatch validated today by test/integration/slash-commands-skills.test.ts (channel-agnostic) and packages/channels/src/signal/signal-format.test.ts at unit-tier.",
  },
  {
    channel: "signal",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "signal",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "signal",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "signal",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // IRC (7 cells — slash is structurally unrepresentable per RESEARCH.md §5)
  // ===========================================================================
  {
    channel: "irc",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock IRC server); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/irc/irc-adapter.test.ts at unit-tier.",
  },
  {
    channel: "irc",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock IRC server); mention parsing validated today by packages/channels/src/irc/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "irc",
    flow: "slash",
    status: "skipped",
    reference:
      "IRC has no native slash-command protocol: bots receive plain PRIVMSG text only. Slash is a client-side convention (e.g., mIRC, irssi) parsed before transmission and is not part of the IRC wire protocol — there is no server-side concept to test end-to-end.",
  },
  {
    channel: "irc",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "irc",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "irc",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "irc",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // LINE (7 cells)
  // ===========================================================================
  {
    channel: "line",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock LINE messaging API server); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/line/line-adapter.test.ts at unit-tier.",
  },
  {
    channel: "line",
    flow: "mention",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock LINE messaging API server); mention parsing validated today by packages/channels/src/line/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "line",
    flow: "slash",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock LINE messaging API server); slash-command dispatch validated today by test/integration/slash-commands-skills.test.ts (channel-agnostic) and packages/channels/src/line/message-mapper.test.ts at unit-tier.",
  },
  {
    channel: "line",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "line",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "line",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "line",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },

  // ===========================================================================
  // Email (7 cells — slash and mention are structurally unrepresentable
  //   per RESEARCH.md §5)
  // ===========================================================================
  {
    channel: "email",
    flow: "dm",
    status: "skipped",
    reference:
      "E2E test deferred to Plan 40-09 (mock SMTP/IMAP server pair); DM dispatch validated today by test/integration/messaging-echo.test.ts via channel-agnostic adapterRegistry resolution and packages/channels/src/email/email-adapter.test.ts at unit-tier.",
  },
  {
    channel: "email",
    flow: "mention",
    status: "skipped",
    reference:
      "Email has no multi-user channel concept and no @-mention semantics in SMTP or IMAP; recipients are addressed via To/Cc/Bcc headers, not via @-mention within message body. There is no protocol-level mention to test end-to-end.",
  },
  {
    channel: "email",
    flow: "slash",
    status: "skipped",
    reference:
      "Email has no native slash-command protocol: commands are encoded in the Subject header or message body and parsed by the email adapter. There is no SMTP/IMAP wire-level slash-command primitive to test end-to-end.",
  },
  {
    channel: "email",
    flow: "scheduled",
    status: "covered",
    reference: "test/integration/delivery-queue-recurring.test.ts",
  },
  {
    channel: "email",
    flow: "followup",
    status: "covered",
    reference: "test/integration/background-completion-runner.test.ts",
  },
  {
    channel: "email",
    flow: "approval",
    status: "covered",
    reference: "test/integration/approval-gate-e2e.test.ts",
  },
  {
    channel: "email",
    flow: "error",
    status: "covered",
    reference: "test/integration/channel-resilience.test.ts",
  },
] as const;
