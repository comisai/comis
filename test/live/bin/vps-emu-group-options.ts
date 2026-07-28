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
