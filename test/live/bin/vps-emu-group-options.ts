// SPDX-License-Identifier: Apache-2.0
import type {
  CreateGroupChatOptions,
  GroupMember,
} from "../emulators/telegram/tg-emulator.js";

export interface StandaloneGroupSpec {
  readonly chatId?: number;
  readonly members: readonly GroupMember[];
  readonly botId?: number;
  readonly botUsername?: string;
  readonly supergroup?: boolean;
  readonly forum?: boolean;
}

const FIRST_MESSAGE_ID = 100;
const RESTART_MESSAGE_ID_BLOCK = 1_000_000;

interface StandaloneEmulatorState {
  readonly messageIdBase?: unknown;
}

/**
 * Reserve a fresh message-id block for each standalone emulator process.
 *
 * Telegram message ids do not rewind when a bot reconnects. The standalone
 * harness persists only this block base, so a restart cannot reuse a stable
 * `(bot, chat, message_id)` identity against an existing Comis session.
 */
export function nextStandaloneMessageIdBase(
  previous: StandaloneEmulatorState | undefined,
): number {
  if (previous === undefined) return FIRST_MESSAGE_ID;
  if (previous.messageIdBase === undefined) {
    return FIRST_MESSAGE_ID + RESTART_MESSAGE_ID_BLOCK;
  }
  if (
    typeof previous.messageIdBase !== "number" ||
    !Number.isSafeInteger(previous.messageIdBase) ||
    previous.messageIdBase < FIRST_MESSAGE_ID ||
    previous.messageIdBase > Number.MAX_SAFE_INTEGER - RESTART_MESSAGE_ID_BLOCK
  ) {
    throw new TypeError("Standalone emulator state has an invalid messageIdBase");
  }
  return previous.messageIdBase + RESTART_MESSAGE_ID_BLOCK;
}

/** Convert the launcher JSON shape without dropping emulator group semantics. */
export function toCreateGroupChatOptions(
  spec: StandaloneGroupSpec,
): CreateGroupChatOptions {
  return {
    ...(spec.chatId !== undefined ? { chatId: spec.chatId } : {}),
    members: spec.members,
    ...(spec.botId !== undefined
      ? { bot: { id: spec.botId, firstName: "bot", username: spec.botUsername ?? "comis_bot" } }
      : {}),
    ...(spec.supergroup !== undefined ? { supergroup: spec.supergroup } : {}),
    ...(spec.forum !== undefined ? { forum: spec.forum } : {}),
  };
}
