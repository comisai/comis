// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityRenderActions — the minimal send/edit/delete port the channel-agnostic
 * rendering strategies call to paint activity to a surface.
 *
 * The strategy bodies in this directory are pure rendering state machines: they
 * decide WHAT to send and WHEN to delete, but never touch a platform SDK. The
 * real per-channel adapter wiring (Telegram/Discord/Slack/...) implements this
 * port; strategy tests pass a tiny in-test recorder.
 *
 * All three operations return `Result<…, ActivityRenderError>` so a strategy can
 * propagate a rate-limit / permission / transient-network failure to the
 * coordinator without throwing. `send` resolves to the created message's id so
 * a strategy can later edit or delete it.
 *
 * `send` accepts an optional `SendOptions.buttons` so a renderer can paint
 * native approval choices alongside the text. The buttons are
 * the signed `RichButton[][]` produced by `buildApprovalButtons` (the
 * `callback_data` is the signed `v1.<choice>.<shortId>.<hmac>` wire string). The param is OPTIONAL: a
 * text-only `send(text)` call — and a renderer/adapter that ignores buttons —
 * remains valid (IRC / Email have no button surface and pass nothing).
 *
 * Type-only file: no I/O, no logger, no platform import. `ActivityRenderError`
 * and `RichButton` are owned by `@comis/core` (the `channels → core` edge).
 */
import type { Result } from "@comis/shared";
import type { ActivityRenderError, RichButton } from "@comis/core";

/** Optional rendering affordances a renderer may attach to a `send`. */
export interface SendOptions {
  /**
   * Signed native approval choices to paint with the message. Each
   * button's `callback_data` is the signed `v1.<choice>.<shortId>.<hmac>` wire
   * string from `buildApprovalButtons`. Platforms without a button affordance
   * (IRC, Email, plain-text) ignore this and render the text-only prompt.
   */
  buttons?: RichButton[][];
}

export interface ActivityRenderActions {
  /**
   * Post a new activity message; resolves to the created message id. The
   * optional `opts.buttons` carries signed approval choices for surfaces that
   * support native buttons; omit it for a plain text line.
   */
  send(text: string, opts?: SendOptions): Promise<Result<string, ActivityRenderError>>;
  /** Edit an existing activity message in place. */
  edit(messageId: string, text: string): Promise<Result<void, ActivityRenderError>>;
  /** Delete an activity message. */
  delete(messageId: string): Promise<Result<void, ActivityRenderError>>;
}
