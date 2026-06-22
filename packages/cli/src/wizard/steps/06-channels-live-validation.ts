// SPDX-License-Identifier: Apache-2.0
/**
 * Live channel-credential validation for the init wizard (step 06).
 *
 * Split out of 06-channels.ts to keep that file under the per-file line cap.
 * Each validator does a single timeboxed fetch against the channel API and
 * classifies failures (auth vs network/proxy/DNS/TLS) so the wizard error
 * names HTTPS_PROXY / NO_PROXY / proxy.tls.caFile when egress is the cause.
 *
 * Live validation uses native fetch (Node 22+) with AbortController timeouts,
 * matching the pattern from 04-credentials.ts.
 *
 * @module
 */
import { systemClearTimeout, systemSetTimeout } from "@comis/core";


/**
 * Validate a Telegram bot token via the getMe API.
 *
 * GET https://api.telegram.org/bot{token}/getMe
 *
 * @internal Exported for unit tests only.
 */
export async function validateTelegramLive(
  token: string,
): Promise<{ valid: boolean; username?: string; id?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = systemSetTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { method: "GET", signal: controller.signal },
    );

    if (response.ok) {
      const data = (await response.json()) as {
        result: { username: string; id: number };
      };
      return { valid: true, username: data.result.username, id: data.result.id };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid bot token" };
    }

    return { valid: false, error: `Telegram API returned ${response.status}` };
  } catch (err: unknown) {
    // AbortController fired (5s timeout) — check BEFORE cause.code since an
    // abort can also set cause in some Node versions.
    if (err instanceof Error && err.name === "AbortError") {
      return {
        valid: false,
        error: "Telegram API timed out after 5s — if HTTPS_PROXY is set, ensure it can reach api.telegram.org.",
      };
    }

    // Extract cause code from Node undici TypeError wrapper
    const cause = err instanceof Error ? (err.cause as Record<string, unknown> | undefined) : undefined;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    const causeMsg = typeof cause?.message === "string" ? cause.message : "";

    if (code === "ETIMEDOUT" || code === "ECONNREFUSED") {
      return {
        valid: false,
        error: `Could not reach Telegram API — ${code}: check HTTPS_PROXY and NO_PROXY (api.telegram.org must be reachable; loopback/NO_PROXY may be misrouting).`,
      };
    }
    if (code === "ENOTFOUND") {
      return {
        valid: false,
        error: `DNS/proxy resolution failed for api.telegram.org — ${code}: if HTTPS_PROXY is set, confirm the proxy server is reachable and api.telegram.org is not in NO_PROXY.`,
      };
    }
    // TLS errors: CERT_* codes OR "certificate" / "SSL" / "TLS" in cause message
    if (code?.startsWith("CERT_") || causeMsg.includes("certificate") || causeMsg.includes("SSL") || causeMsg.includes("TLS")) {
      return {
        valid: false,
        error: "TLS error reaching Telegram — a TLS-intercepting proxy needs its CA certificate set via proxy.tls.caFile in config.yaml.",
      };
    }
    // Unknown — include code if available; never interpolate token or URL
    const codeStr = code ? ` (${code})` : "";
    return { valid: false, error: `Could not reach Telegram API${codeStr}.` };
  } finally {
    systemClearTimeout(timeout);
  }
}

/**
 * Validate a Discord bot token via /users/@me.
 *
 * GET https://discord.com/api/v10/users/@me with Authorization: Bot {token}
 *
 * @internal Exported for unit tests only.
 */
export async function validateDiscordLive(
  token: string,
): Promise<{ valid: boolean; username?: string; discriminator?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = systemSetTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      "https://discord.com/api/v10/users/@me",
      {
        method: "GET",
        headers: { Authorization: `Bot ${token}` },
        signal: controller.signal,
      },
    );

    if (response.ok) {
      const data = (await response.json()) as {
        username: string;
        discriminator: string;
      };
      return { valid: true, username: data.username, discriminator: data.discriminator };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid bot token" };
    }

    return { valid: false, error: `Discord API returned ${response.status}` };
  } catch (err: unknown) {
    // AbortController fired (5s timeout) — check BEFORE cause.code
    if (err instanceof Error && err.name === "AbortError") {
      return {
        valid: false,
        error: "Discord API timed out after 5s — if HTTPS_PROXY is set, ensure it can reach discord.com.",
      };
    }

    // Extract cause code from Node undici TypeError wrapper
    const cause = err instanceof Error ? (err.cause as Record<string, unknown> | undefined) : undefined;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    const causeMsg = typeof cause?.message === "string" ? cause.message : "";

    if (code === "ETIMEDOUT" || code === "ECONNREFUSED") {
      return {
        valid: false,
        error: `Could not reach Discord API — ${code}: check HTTPS_PROXY and NO_PROXY (discord.com must be reachable; loopback/NO_PROXY may be misrouting).`,
      };
    }
    if (code === "ENOTFOUND") {
      return {
        valid: false,
        error: `DNS/proxy resolution failed for discord.com — ${code}: if HTTPS_PROXY is set, confirm the proxy server is reachable and discord.com is not in NO_PROXY.`,
      };
    }
    if (code?.startsWith("CERT_") || causeMsg.includes("certificate") || causeMsg.includes("SSL") || causeMsg.includes("TLS")) {
      return {
        valid: false,
        error: "TLS error reaching Discord — a TLS-intercepting proxy needs its CA certificate set via proxy.tls.caFile in config.yaml.",
      };
    }
    const codeStr = code ? ` (${code})` : "";
    return { valid: false, error: `Could not reach Discord API${codeStr}.` };
  } finally {
    systemClearTimeout(timeout);
  }
}

/**
 * Validate a Slack bot token via auth.test.
 *
 * POST https://slack.com/api/auth.test with Authorization: Bearer {botToken}
 *
 * @internal Exported for unit tests only.
 */
export async function validateSlackLive(
  botToken: string,
): Promise<{ valid: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = systemSetTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: controller.signal,
    });

    if (response.ok) {
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        return { valid: true };
      }
      return { valid: false, error: data.error ?? "Auth test failed" };
    }

    return { valid: false, error: `Slack API returned ${response.status}` };
  } catch (err: unknown) {
    // AbortController fired (5s timeout) — check BEFORE cause.code
    if (err instanceof Error && err.name === "AbortError") {
      return {
        valid: false,
        error: "Slack API timed out after 5s — if HTTPS_PROXY is set, ensure it can reach slack.com.",
      };
    }

    // Extract cause code from Node undici TypeError wrapper
    const cause = err instanceof Error ? (err.cause as Record<string, unknown> | undefined) : undefined;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    const causeMsg = typeof cause?.message === "string" ? cause.message : "";

    if (code === "ETIMEDOUT" || code === "ECONNREFUSED") {
      return {
        valid: false,
        error: `Could not reach Slack API — ${code}: check HTTPS_PROXY and NO_PROXY (slack.com must be reachable; loopback/NO_PROXY may be misrouting).`,
      };
    }
    if (code === "ENOTFOUND") {
      return {
        valid: false,
        error: `DNS/proxy resolution failed for slack.com — ${code}: if HTTPS_PROXY is set, confirm the proxy server is reachable and slack.com is not in NO_PROXY.`,
      };
    }
    if (code?.startsWith("CERT_") || causeMsg.includes("certificate") || causeMsg.includes("SSL") || causeMsg.includes("TLS")) {
      return {
        valid: false,
        error: "TLS error reaching Slack — a TLS-intercepting proxy needs its CA certificate set via proxy.tls.caFile in config.yaml.",
      };
    }
    const codeStr = code ? ` (${code})` : "";
    return { valid: false, error: `Could not reach Slack API${codeStr}.` };
  } finally {
    systemClearTimeout(timeout);
  }
}

/**
 * Validate a LINE channel access token via getBotInfo.
 *
 * GET https://api.line.me/v2/bot/info with Authorization: Bearer {channelToken}
 *
 * @internal Exported for unit tests only.
 */
export async function validateLineLive(
  channelToken: string,
): Promise<{ valid: boolean; displayName?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = systemSetTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("https://api.line.me/v2/bot/info", {
      method: "GET",
      headers: { Authorization: `Bearer ${channelToken}` },
      signal: controller.signal,
    });

    if (response.ok) {
      const data = (await response.json()) as { displayName: string };
      return { valid: true, displayName: data.displayName };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid channel token" };
    }

    return { valid: false, error: `LINE API returned ${response.status}` };
  } catch (err: unknown) {
    // AbortController fired (5s timeout) — check BEFORE cause.code
    if (err instanceof Error && err.name === "AbortError") {
      return {
        valid: false,
        error: "LINE API timed out after 5s — if HTTPS_PROXY is set, ensure it can reach api.line.me.",
      };
    }

    // Extract cause code from Node undici TypeError wrapper
    const cause = err instanceof Error ? (err.cause as Record<string, unknown> | undefined) : undefined;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    const causeMsg = typeof cause?.message === "string" ? cause.message : "";

    if (code === "ETIMEDOUT" || code === "ECONNREFUSED") {
      return {
        valid: false,
        error: `Could not reach LINE API — ${code}: check HTTPS_PROXY and NO_PROXY (api.line.me must be reachable; loopback/NO_PROXY may be misrouting).`,
      };
    }
    if (code === "ENOTFOUND") {
      return {
        valid: false,
        error: `DNS/proxy resolution failed for api.line.me — ${code}: if HTTPS_PROXY is set, confirm the proxy server is reachable and api.line.me is not in NO_PROXY.`,
      };
    }
    if (code?.startsWith("CERT_") || causeMsg.includes("certificate") || causeMsg.includes("SSL") || causeMsg.includes("TLS")) {
      return {
        valid: false,
        error: "TLS error reaching LINE — a TLS-intercepting proxy needs its CA certificate set via proxy.tls.caFile in config.yaml.",
      };
    }
    const codeStr = code ? ` (${code})` : "";
    return { valid: false, error: `Could not reach LINE API${codeStr}.` };
  } finally {
    systemClearTimeout(timeout);
  }
}
