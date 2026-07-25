// SPDX-License-Identifier: Apache-2.0

import type { Bot } from "grammy";
import { err, ok, type Result } from "@comis/shared";
import type { TelegramAdapterState } from "./telegram-adapter-types.js";

/** Resolve the Bot only while its polling generation is available for sends. */
export function getActiveBot(state: TelegramAdapterState): Result<Bot, Error> {
  return state.connected
    ? ok(state.bot)
    : err(new Error("Telegram adapter is not connected"));
}
