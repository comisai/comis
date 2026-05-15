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
 * Classification (Plan 40-09 close):
 *   - 60 covered cells:
 *       - 36 from Plan 40-08 close: every (channel × {approval, scheduled,
 *         followup, error}) pair maps to an existing channel-agnostic
 *         integration E2E (delivery-queue-recurring, background-completion-
 *         runner, approval-gate-e2e, channel-resilience).
 *       - 24 flipped from skipped-to-covered by Plan 40-09 Wave E: every
 *         (channel × {dm, mention, slash}) pair that has a corresponding
 *         test/e2e/<channel>-dm.test.ts file exercising the production
 *         channel adapter against a 127.0.0.1 mock platform server. Each
 *         per-channel dm.test.ts also covers mention + slash because the
 *         underlying wire endpoint is the same; content-level mention/slash
 *         parsing is exercised at the unit tier (message-mapper.test.ts).
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
 * Phase 40 / Phase C §6.5 / COV-12 + COV-15.
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
    status: "covered",
    reference: "test/e2e/discord-dm.test.ts",
  },
  {
    channel: "discord",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/discord-dm.test.ts",
  },
  {
    channel: "discord",
    flow: "slash",
    status: "covered",
    reference: "test/e2e/discord-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/telegram-dm.test.ts",
  },
  {
    channel: "telegram",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/telegram-dm.test.ts",
  },
  {
    channel: "telegram",
    flow: "slash",
    status: "covered",
    reference: "test/e2e/telegram-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/slack-dm.test.ts",
  },
  {
    channel: "slack",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/slack-dm.test.ts",
  },
  {
    channel: "slack",
    flow: "slash",
    status: "covered",
    reference: "test/e2e/slack-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/whatsapp-dm.test.ts",
  },
  {
    channel: "whatsapp",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/whatsapp-dm.test.ts",
  },
  {
    channel: "whatsapp",
    flow: "slash",
    status: "covered",
    reference: "test/e2e/whatsapp-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/imessage-dm.test.ts",
  },
  {
    channel: "imessage",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/imessage-dm.test.ts",
  },
  {
    channel: "imessage",
    flow: "slash",
    status: "covered",
    reference: "test/e2e/imessage-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/signal-dm.test.ts",
  },
  {
    channel: "signal",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/signal-dm.test.ts",
  },
  {
    channel: "signal",
    flow: "slash",
    status: "covered",
    reference: "test/e2e/signal-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/irc-dm.test.ts",
  },
  {
    channel: "irc",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/irc-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/line-dm.test.ts",
  },
  {
    channel: "line",
    flow: "mention",
    status: "covered",
    reference: "test/e2e/line-dm.test.ts",
  },
  {
    channel: "line",
    flow: "slash",
    status: "covered",
    reference: "test/e2e/line-dm.test.ts",
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
    status: "covered",
    reference: "test/e2e/email-dm.test.ts",
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
