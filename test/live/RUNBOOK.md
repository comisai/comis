# CHAN-02 — Manual Real-Account Channel Round-Trip Runbook

The echo golden round-trip (CHAN-01) and the delivery / streaming / queue / dmScope matrix
(CHAN-03) are **automated** in the live tier (`pnpm test:live channels`, deterministic Stage-B).
The **real-account send → agent → reply round-trip** per channel (CHAN-02) **cannot be automated
in CI** — there are no real channel accounts in the sandbox — so it is recorded here.

This tier is **operator-run**, **env-gated** (`COMIS_LIVE=1` + the channel's credentials), and
**skip ≠ fail**: an absent account is `SKIPPED(no-account)`, **never a failure**. Launch-set
selection is the operator's call; this runbook treats **all 9 real
channels** as the launch set (Discord, Telegram, Slack, WhatsApp, Signal, iMessage, LINE, IRC,
Email).

---

## Prerequisites

- The `comis` CLI is **not on PATH** — invoke it as `node packages/cli/dist/cli.js <command>`
  (build first with `pnpm build`).
- The daemon must be running (see `CLAUDE.md` → Daemon). Configure each channel's credentials in
  `~/.comis/config.yaml` (secrets may be referenced via `${VAR}` from `~/.comis/.env`).
- Overall daemon health before per-channel checks:
  ```bash
  node packages/cli/dist/cli.js doctor
  node packages/cli/dist/cli.js health
  node packages/cli/dist/cli.js status
  ```
- Per-channel connectivity (credential validation against the real platform API):
  ```bash
  node packages/cli/dist/cli.js channel test
  ```

The round-trip itself, for every channel, is the same shape:

1. Configure the channel's credential(s).
2. `node packages/cli/dist/cli.js channel test` → expect the channel to validate (bot identity / connection OK).
3. From the **real client** of that channel, send a message to the configured bot/account.
4. Confirm the **agent replies** in that channel.
5. Record PASS/FAIL in the table below.

---

## Per-channel notes

### Discord
- Credential: bot token (`DISCORD_BOT_TOKEN` or `config.yaml`).
- Validate: `node packages/cli/dist/cli.js channel test` (calls Discord `/users/@me`).
- Round-trip: DM the bot (or @-mention it in a guild channel it can read) → expect a reply.

### Telegram
- Credential: bot token (`TELEGRAM_BOT_TOKEN`). Webhook secret (if used) is shape-validated locally.
- Validate: `channel test` (calls `getMe`).
- Round-trip: message the bot in Telegram → expect a reply.

### Slack
- Credential: bot token (`xoxb-…`) + **either** an app token (`xapp-…`, Socket Mode) **or** a
  signing secret (HTTP Mode). The socket-vs-http credential branch is covered deterministically in
  `test/live/scenarios/channels/echo-golden.test.ts`; the **live connection** is manual.
- Validate: `channel test` (calls `auth.test`).
- Round-trip: DM the bot (or mention it) → expect a reply. Note which mode (socket / http) was used.

### WhatsApp
- Credential: a writable Baileys auth-state directory (first run prints a QR to link the device).
- Validate: `channel test` (checks the auth dir + linked session).
- Round-trip: message the linked WhatsApp number → expect a reply.

### Signal
- Credential: a running `signal-cli` REST `baseUrl` + a registered account.
- Validate: `channel test` (health-checks the Signal REST service + lists accounts).
- Round-trip: message the registered Signal number → expect a reply.

### iMessage
- Credential: macOS + the `imsg` binary on PATH (Apple-platform only).
- Validate: `channel test` (checks macOS + the `imsg` binary + its rpc subcommand).
- Round-trip: iMessage the configured account → expect a reply. (Linux/non-macOS ⇒ `SKIPPED`.)

### LINE
- Credential: channel access token + channel secret (the secret is needed for webhook signature verification).
- Validate: `channel test` (calls `getBotInfo`).
- Round-trip: message the LINE official account → expect a reply.

### IRC
- Credential: host + nick (+ optional password/SASL).
- Validate: `channel test` (connects + registers, then disconnects).
- Round-trip: message the bot on the configured IRC network/channel → expect a reply.

### Email
- Credential: IMAP host/port/security + auth (password **or** OAuth2 access token). The
  `email.authType` {password, oauth2} live cells require a real IMAP server / OAuth.
- Validate: `channel test` (attempts an IMAP connection + logout).
- Round-trip: send an email to the configured mailbox → expect a reply email.

---

## Round-trip recording table

Fill one row per channel per run. `Round-trip` = PASS/FAIL (or `SKIPPED(no-account)`).

| Channel  | Cred configured | `channel test` green | Sent inbound | Agent replied | Round-trip | Date | Notes |
|----------|-----------------|----------------------|--------------|---------------|------------|------|-------|
| Discord  |                 |                      |              |               | PASS/FAIL  |      |       |
| Telegram |                 |                      |              |               | PASS/FAIL  |      |       |
| Slack    |                 |                      |              |               | PASS/FAIL  |      |       |
| WhatsApp |                 |                      |              |               | PASS/FAIL  |      |       |
| Signal   |                 |                      |              |               | PASS/FAIL  |      |       |
| iMessage |                 |                      |              |               | PASS/FAIL  |      |       |
| LINE     |                 |                      |              |               | PASS/FAIL  |      |       |
| IRC      |                 |                      |              |               | PASS/FAIL  |      |       |
| Email    |                 |                      |              |               | PASS/FAIL  |      |       |

---

## Coverage accounting

Until an operator records these round-trips, the real-account coverage is **`SKIPPED(no-account)`**
in the live report — see:

- `test/live/coverage-matrix.ts` — `slack.mode` (socket/http live connection) and `email.authType`
  (password/oauth2 live IMAP) cells stay `skipped` with a Stage-C / no-account reason.
- The `describe.skipIf(!isLive)` + `it.skip` Stage-C blocks in
  `test/live/scenarios/channels/echo-golden.test.ts` (positive token validation + send→reply) and
  `test/live/scenarios/channels/delivery-modes.test.ts` (real paced streamed delivery).

`SKIPPED(no-account)` is never a failure — it is the honest accounting of a tier that requires real
credentials an operator must supply.
