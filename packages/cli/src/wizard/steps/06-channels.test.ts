// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for channel setup step (step 06).
 *
 * Verifies channel multiselect, per-channel credential collection,
 * live API validation with retry/skip, deferred guidance channels
 * (WhatsApp, Signal), and IRC auto-add.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState, ProviderConfig } from "../types.js";
import { INITIAL_STATE } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

import { channelsStep } from "./06-channels.js";

// ---------- Mock Prompter Factory ----------

function createMockPrompter(
  overrides: Partial<Record<string, unknown>> = {},
): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn().mockResolvedValue(overrides.select),
    multiselect: vi.fn().mockResolvedValue(overrides.multiselect ?? []),
    text: vi.fn().mockResolvedValue(overrides.text ?? ""),
    password: vi.fn().mockResolvedValue(overrides.password ?? ""),
    confirm: vi.fn().mockResolvedValue(overrides.confirm ?? true),
    spinner: vi.fn(
      (): Spinner => ({
        start: vi.fn(),
        update: vi.fn(),
        stop: vi.fn(),
      }),
    ),
    group: vi.fn(
      async (steps: Record<string, () => Promise<unknown>>) => {
        const results: Record<string, unknown> = {};
        for (const [key, fn] of Object.entries(steps)) {
          results[key] = await fn();
        }
        return results;
      },
    ),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
}

// ---------- Tests ----------

describe("channelsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct step id and label", () => {
    expect(channelsStep.id).toBe("channels");
    expect(channelsStep.label).toBe("Channel Setup");
  });

  it("adds telegram with valid token to state.channels", async () => {
    const validTelegramToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";

    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["telegram"]);
    vi.mocked(prompter.password).mockResolvedValueOnce(validTelegramToken);

    // Mock successful Telegram API validation
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ result: { username: "test_bot", id: 12345 } }),
    } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.channels).toBeDefined();
    expect(result.channels).toHaveLength(1);
    expect(result.channels![0].type).toBe("telegram");
    expect(result.channels![0].botToken).toBe(validTelegramToken);
    expect(result.channels![0].validated).toBe(true);
  });

  it("adds multiple channels (telegram + discord) to state", async () => {
    const telegramToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";
    const discordToken = "A".repeat(60); // 60+ chars for Discord token

    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce([
      "telegram",
      "discord",
    ]);

    // Telegram token, then Discord token, then guild IDs
    vi.mocked(prompter.password)
      .mockResolvedValueOnce(telegramToken) // telegram
      .mockResolvedValueOnce(discordToken); // discord
    vi.mocked(prompter.text).mockResolvedValueOnce(""); // guild IDs (empty)

    // Telegram API success
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ result: { username: "tg_bot", id: 111 } }),
      } as Response)
      // Discord API success
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ username: "dc_bot", discriminator: "0" }),
      } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.channels).toHaveLength(2);
    expect(result.channels![0].type).toBe("telegram");
    expect(result.channels![1].type).toBe("discord");
  });

  it("shows deferred guidance note for whatsapp (no credential prompt)", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["whatsapp"]);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.channels).toHaveLength(1);
    expect(result.channels![0].type).toBe("whatsapp");
    expect(result.channels![0].validated).toBe(false);
    // No password prompt for WhatsApp
    expect(prompter.password).not.toHaveBeenCalled();
    // Note displayed with guidance
    expect(prompter.note).toHaveBeenCalled();
  });

  it("adds IRC directly with no prompts", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["irc"]);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.channels).toHaveLength(1);
    expect(result.channels![0].type).toBe("irc");
    expect(result.channels![0].validated).toBe(true);
    // No password prompt for IRC
    expect(prompter.password).not.toHaveBeenCalled();
    expect(prompter.log.info).toHaveBeenCalled();
  });

  it("handles channel credential validation failure with retry/skip", async () => {
    const invalidToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";

    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["telegram"]);
    vi.mocked(prompter.password).mockResolvedValue(invalidToken);

    // Telegram API returns 401
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    // User chooses "skip"
    vi.mocked(prompter.select).mockResolvedValueOnce("skip");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    // Skipped channel means no channels added (or empty array)
    expect(result.channels?.length ?? 0).toBe(0);
  });

  it("returns original state when no channels are selected", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce([]);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    // No channels field set (or state unchanged)
    expect(result.channels).toBeUndefined();
    expect(prompter.log.info).toHaveBeenCalled();
  });

  it("handles channel validation failure with continue-anyway", async () => {
    const telegramToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";

    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["telegram"]);
    vi.mocked(prompter.password).mockResolvedValueOnce(telegramToken);

    // Telegram API fails
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
    } as Response);

    // User chooses "continue"
    vi.mocked(prompter.select).mockResolvedValueOnce("continue");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.channels).toHaveLength(1);
    expect(result.channels![0].type).toBe("telegram");
    expect(result.channels![0].validated).toBe(false);
  });

  it("handles signal channel with deferred guidance", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["signal"]);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.channels).toHaveLength(1);
    expect(result.channels![0].type).toBe("signal");
    expect(result.channels![0].validated).toBe(false);
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("prompts for sender trust after channel collection and stores entries", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["irc"]);
    vi.mocked(prompter.confirm).mockResolvedValueOnce(true);
    vi.mocked(prompter.text).mockResolvedValueOnce("12345, 67890");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.senderTrustEntries).toEqual([
      { senderId: "12345", level: "admin" },
      { senderId: "67890", level: "admin" },
    ]);
  });

  it("skips sender trust when user declines", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["irc"]);
    vi.mocked(prompter.confirm).mockResolvedValueOnce(false);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    const result = await channelsStep.execute(state, prompter);

    expect(result.senderTrustEntries).toBeUndefined();
  });

  it("skips sender trust when no channels selected", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce([]);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    await channelsStep.execute(state, prompter);

    // confirm should NOT have been called for trust prompt
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("auto-detects Telegram user ID from getUpdates when user opts in", async () => {
    const telegramToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";

    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["telegram"]);
    vi.mocked(prompter.password).mockResolvedValueOnce(telegramToken);

    // Telegram getMe success
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: { username: "test_bot", id: 12345 } }),
    } as Response);

    // confirm: want trust? → yes, auto-detect? → yes, use ID? → yes, restrict bot? → yes
    vi.mocked(prompter.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    // Telegram getUpdates returns a message
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: [{ message: { from: { id: 99999, first_name: "Alice" } } }],
      }),
    } as Response);

    const state: WizardState = { ...INITIAL_STATE, flow: "advanced" };
    const result = await channelsStep.execute(state, prompter);

    // Telegram-only: skips text prompt, uses detected ID directly
    expect(prompter.text).not.toHaveBeenCalled();
    expect(result.senderTrustEntries).toEqual([
      { senderId: "99999", level: "admin" },
    ]);
    // allowFrom set on the telegram channel config
    expect(result.channels![0].allowFrom).toEqual(["99999"]);
  });

  it("falls back to manual entry when getUpdates finds no messages", async () => {
    const telegramToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";

    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["telegram"]);
    vi.mocked(prompter.password).mockResolvedValueOnce(telegramToken);

    // Telegram getMe success
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: { username: "test_bot", id: 12345 } }),
    } as Response);

    // confirm: want trust? → yes, auto-detect? → yes, (no use-ID since empty), restrict bot? → yes
    vi.mocked(prompter.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    // Telegram getUpdates returns empty
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: [] }),
    } as Response);

    vi.mocked(prompter.text).mockResolvedValueOnce("manual123");

    const state: WizardState = { ...INITIAL_STATE, flow: "advanced" };
    const result = await channelsStep.execute(state, prompter);

    expect(prompter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Send a message to your bot"),
    );
    expect(result.senderTrustEntries).toEqual([
      { senderId: "manual123", level: "admin" },
    ]);
    expect(result.channels![0].allowFrom).toEqual(["manual123"]);
  });

  it("skips auto-detect when user declines and shows manual guidance", async () => {
    const telegramToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";

    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce(["telegram"]);
    vi.mocked(prompter.password).mockResolvedValueOnce(telegramToken);

    // Telegram getMe success
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: { username: "test_bot", id: 12345 } }),
    } as Response);

    // confirm: want trust? → yes, auto-detect? → no, restrict bot? → no
    vi.mocked(prompter.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    vi.mocked(prompter.text).mockResolvedValueOnce("manual456");

    const state: WizardState = { ...INITIAL_STATE, flow: "advanced" };
    const result = await channelsStep.execute(state, prompter);

    // No getUpdates call should have been made
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // only getMe
    expect(result.senderTrustEntries).toEqual([
      { senderId: "manual456", level: "admin" },
    ]);
    // User declined restrict — no allowFrom
    expect(result.channels![0].allowFrom).toBeUndefined();
  });

  it("multiselect offers all 7 supported channels", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValueOnce([]);

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
    };

    await channelsStep.execute(state, prompter);

    expect(prompter.multiselect).toHaveBeenCalledOnce();
    const multiselectCall = (
      prompter.multiselect as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as {
      options: Array<{ value: string }>;
    };
    expect(multiselectCall.options).toHaveLength(7);

    const values = multiselectCall.options.map(
      (o: { value: string }) => o.value,
    );
    expect(values).toContain("telegram");
    expect(values).toContain("discord");
    expect(values).toContain("slack");
    expect(values).toContain("whatsapp");
    expect(values).toContain("signal");
    expect(values).toContain("irc");
    expect(values).toContain("line");
  });
});
