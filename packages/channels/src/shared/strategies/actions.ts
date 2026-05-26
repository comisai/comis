// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityRenderActions — the minimal send/edit/delete port the channel-agnostic
 * rendering strategies (§7.2) call to paint activity to a surface.
 *
 * The strategy bodies in this directory are pure rendering state machines: they
 * decide WHAT to send and WHEN to delete, but never touch a platform SDK. The
 * real per-channel adapter wiring (Telegram/Discord/Slack/...) implements this
 * port in Phases 71-72; strategy tests pass a tiny in-test recorder.
 *
 * All three operations return `Result<…, ActivityRenderError>` so a strategy can
 * propagate a rate-limit / permission / transient-network failure to the
 * coordinator without throwing. `send` resolves to the created message's id so
 * a strategy can later edit or delete it.
 *
 * Type-only file: no I/O, no logger, no platform import. `ActivityRenderError`
 * is the closed union owned by `@comis/core` (the `channels → core` edge).
 */
import type { Result } from "@comis/shared";
import type { ActivityRenderError } from "@comis/core";

export interface ActivityRenderActions {
  /** Post a new activity message; resolves to the created message id. */
  send(text: string): Promise<Result<string, ActivityRenderError>>;
  /** Edit an existing activity message in place. */
  edit(messageId: string, text: string): Promise<Result<void, ActivityRenderError>>;
  /** Delete an activity message. */
  delete(messageId: string): Promise<Result<void, ActivityRenderError>>;
}
