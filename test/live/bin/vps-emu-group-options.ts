// SPDX-License-Identifier: Apache-2.0
import { closeSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
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
const MESSAGE_ID_TIME_UNIT_MS = 1_000;

interface StandaloneEmulatorState {
  readonly messageIdBase?: unknown;
}

/**
 * Reserve a fresh message-id block for each standalone emulator process.
 *
 * Telegram message ids do not rewind when a bot reconnects. The standalone
 * harness advances the persisted block base and also applies a wall-clock
 * floor. Losing an ephemeral wiring file therefore cannot reuse a stable
 * `(bot, chat, message_id)` identity retained by an existing Comis session.
 */
export function reserveStandaloneMessageIdBase(
  previous: StandaloneEmulatorState | undefined,
  reservationDirectory: string,
): number {
  const freshBase = Math.max(
    FIRST_MESSAGE_ID,
    Math.floor(Date.now() / MESSAGE_ID_TIME_UNIT_MS),
  );
  let previousFloor = FIRST_MESSAGE_ID;
  if (previous?.messageIdBase !== undefined) {
    if (
      typeof previous.messageIdBase !== "number"
      || !Number.isSafeInteger(previous.messageIdBase)
      || previous.messageIdBase < FIRST_MESSAGE_ID
      || previous.messageIdBase > Number.MAX_SAFE_INTEGER - RESTART_MESSAGE_ID_BLOCK
    ) {
      throw new TypeError("Standalone emulator state has an invalid messageIdBase");
    }
    previousFloor = previous.messageIdBase + RESTART_MESSAGE_ID_BLOCK;
  }

  mkdirSync(reservationDirectory, { recursive: true, mode: 0o700 });
  const reservedBases = readdirSync(reservationDirectory)
    .map((name) => Number(name))
    .filter((value) => Number.isSafeInteger(value) && value >= FIRST_MESSAGE_ID);
  const greatestReservedBase = reservedBases.reduce(
    (greatest, value) => Math.max(greatest, value),
    FIRST_MESSAGE_ID - RESTART_MESSAGE_ID_BLOCK,
  );
  let candidate = Math.max(
    freshBase,
    previousFloor,
    greatestReservedBase + RESTART_MESSAGE_ID_BLOCK,
  );

  while (candidate <= Number.MAX_SAFE_INTEGER - RESTART_MESSAGE_ID_BLOCK) {
    try {
      const handle = openSync(resolve(reservationDirectory, String(candidate)), "wx", 0o600);
      closeSync(handle);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      candidate += RESTART_MESSAGE_ID_BLOCK;
    }
  }
  throw new RangeError("Standalone emulator message-id reservations are exhausted");
}

/** The emulator's own bot identity — a group's bot member MUST match it or mentions can never fire. */
export const EMULATOR_BOT_ID = 12345;
export const EMULATOR_BOT_USERNAME = "test_bot";

const KNOWN_SPEC_KEYS = new Set([
  "chatId",
  "members",
  "botId",
  "botUsername",
  "supergroup",
  "forum",
]);

/**
 * Validate one `EMU_GROUPS` entry, loudly.
 *
 * Two silent-acceptance shapes made every mention-gated group arc undrivable while the launch
 * banner still looked healthy:
 *   1. An unknown key — `{id: -100…}` instead of `{chatId: -100…}` — left `chatId` undefined, so
 *      the emulator minted its own id and the driver addressed a chat the plan never referenced.
 *   2. A `botId`/`botUsername` inconsistent with the emulator's own identity made the group's bot
 *      member a DIFFERENT bot than the one the daemon authenticates as, so `isBotMentioned` was
 *      permanently false and no @mention could ever activate.
 * Both now throw with the expected shape rather than defaulting.
 */
export function assertValidGroupSpec(spec: unknown, index = 0): StandaloneGroupSpec {
  const where = `EMU_GROUPS[${index}]`;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new TypeError(`${where} must be an object`);
  }
  const unknown = Object.keys(spec).filter((k) => !KNOWN_SPEC_KEYS.has(k));
  if (unknown.length > 0) {
    throw new TypeError(
      `${where} has unknown key(s) [${unknown.join(", ")}]. Expected shape: ` +
        `{chatId, members:[{id,firstName,username?}], botId?, botUsername?, supergroup?, forum?}. ` +
        `Note the group id key is "chatId", not "id".`,
    );
  }
  const s = spec as StandaloneGroupSpec;
  if (!Array.isArray(s.members) || s.members.length === 0) {
    throw new TypeError(`${where}.members must be a non-empty array of {id, firstName, username?}`);
  }
  if (s.chatId === undefined) {
    throw new TypeError(
      `${where}.chatId is required — omitting it lets the emulator mint an id the driver will not address`,
    );
  }
  if (s.botId !== undefined && s.botId !== EMULATOR_BOT_ID) {
    throw new TypeError(
      `${where}.botId=${s.botId} does not match the emulator bot id ${EMULATOR_BOT_ID}; ` +
        `the group's bot member would be a different bot than the daemon authenticates as, so ` +
        `@mentions could never activate. Omit botId, or set it to ${EMULATOR_BOT_ID}.`,
    );
  }
  if (s.botUsername !== undefined && s.botUsername !== EMULATOR_BOT_USERNAME) {
    throw new TypeError(
      `${where}.botUsername=${JSON.stringify(s.botUsername)} does not match the emulator bot ` +
        `username ${JSON.stringify(EMULATOR_BOT_USERNAME)}; mention entities are built for the ` +
        `emulator's handle, so activation could never match. Omit it, or use ` +
        `${JSON.stringify(EMULATOR_BOT_USERNAME)}.`,
    );
  }
  return s;
}

/** Convert the launcher JSON shape without dropping emulator group semantics. */
export function toCreateGroupChatOptions(
  spec: StandaloneGroupSpec,
): CreateGroupChatOptions {
  return {
    ...(spec.chatId !== undefined ? { chatId: spec.chatId } : {}),
    members: spec.members,
    bot: {
      id: spec.botId ?? EMULATOR_BOT_ID,
      firstName: "bot",
      username: spec.botUsername ?? EMULATOR_BOT_USERNAME,
    },
    ...(spec.supergroup !== undefined ? { supergroup: spec.supergroup } : {}),
    ...(spec.forum !== undefined ? { forum: spec.forum } : {}),
  };
}
