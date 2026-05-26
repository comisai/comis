// SPDX-License-Identifier: Apache-2.0
/**
 * Email DigestOnly activity renderer (CHAN-10, CHAN-11; §7.2 / §18.3 row
 * "DigestOnly"). Email is the largest-cap, send-only channel — it wires the
 * Phase-70 `createDigestOnlyRenderer`: buffer the trail in `apply`, send NOTHING
 * mid-turn, send NOTHING on success (the assistant reply IS the activity, so a
 * separate "done" email would be noise), and on failure emit exactly ONE
 * failure-digest carrying the activity trail (a `FAILED {errorKind}` header line
 * plus one bullet line per trailed event) so a failed turn still leaves a
 * diagnostic record. Three parts, copying the Phase-71/72 `classify<Ch>Error`
 * / `make<Ch>RenderActions` /
 * `create<Ch>ActivityRenderer` shape (imessage-activity.ts is the closest
 * send-only structural analog — `buttons:"none"`, no rich effect, thin wiring):
 *
 *   1. `classifyEmailError` — the single net-new piece of logic here. The live
 *      email adapter returns a bare nodemailer `Error` (`err(error)`) on an SMTP
 *      send failure (and a not-started guard `new Error("Email adapter not
 *      started — call start() first")`), with NO structured numeric code attached
 *      to the RETURNED object — the `errorKind:"network"` tag lives only on the
 *      adapter's OWN log call, not on the value handed back. There is no reliable
 *      structural signal to disambiguate a richer variant on the returned error,
 *      so the classifier DEFAULTS to `{kind:"internal", cause:e}` (KISS —
 *      Pitfall 4; no invented rich classifier). SEC-05/§19.3: the SMTP error body
 *      is read for NOTHING user-facing — it selects the variant only and is NEVER
 *      rendered or logged as activity text. The S4 fixture proves the digest body
 *      is the `FAILED {errorKind}` header + the redacted bullet trail, not the
 *      SMTP error message.
 *
 *   2. `makeEmailRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts the digest body via `adapter.sendMessage` (NO silent effect — Email
 *      sends no silent flag; NO buttons — `buttons:"none"`). `edit` and `delete`
 *      return `not_supported` immediately — Email has neither and the live adapter
 *      exposes no `editMessage` / `deleteMessage` (a guard, never
 *      `adapter.editMessage!` — AGENTS.md §2.8). DigestOnly never calls edit/delete
 *      (canEdit/canDelete are false), but the port contract requires both; an early
 *      `not_supported` is the honest answer. All paths return `Result`; nothing
 *      throws across the boundary.
 *
 *   3. `createEmailActivityRenderer` — wires the Phase-70
 *      {@link createDigestOnlyRenderer}. DigestOnly is purely end-of-turn (it
 *      schedules nothing), so its deps are `{ actions }` ONLY — there is NO
 *      TimerPort / ClockPort (Pitfall 5). It does NOT re-implement the digest body:
 *      the `FAILED {errorKind}` header + bullet-trail assembly lives in
 *      `digest-only.ts`. This is the signature the 72-05 WIRE-02 daemon wiring
 *      constructs.
 *
 * Subject vs. body boundary: the threading subject a mail client shows (the
 * reply prefix + the original thread title) is the EMAIL TRANSPORT SUBJECT LINE
 * — a threading-header concern the email adapter sets on its OWN send path
 * (existing reply-threading behavior), OUTSIDE the `send(text)` string this
 * renderer controls. The renderer's digest BODY is the `FAILED {errorKind}`
 * header + the trail; the reply-prefix subject is never injected into the body
 * string (doing so would diverge from the Phase-70 DigestOnly body and trip
 * CHAN-11).
 *
 * Approval link (APV-10 / SEC-06): Email cannot show buttons, so the single-use,
 * time-bounded, signed LINK to the gateway approval-token route IS the approval
 * action. When the `[FAILED]` digest's buffered trail carries a `kind:"approval"`
 * event AND the daemon composition root injected a `mintApprovalLink` accessor,
 * the digest body appends that link (an `ApprovalLinkRenderer` that scans the
 * trail and mints the URL). The body carries the OPAQUE link only — the token is
 * minted server-side (`generateStrongToken()`) and the signed-callback HMAC wire
 * format never appears in an email body (SEC-06 / T-73-31). When no minter is
 * injected (pre-wiring) or the trail has no approval event, the digest stays the
 * byte-stable Phase-72 `[FAILED] {errorKind}` + bullet trail, so the 5 golden
 * fixtures are unaffected. The renderer reaches NO orchestrator/router code — it
 * only invokes the injected accessor (Pitfall 5).
 *
 * The channels package depends on core + shared only (no observability substrate),
 * so no diagnostics primitive is reachable here.
 */
import { ok, err, type Result } from "@comis/shared";
import type { ChannelActivityRenderer, ActivityRenderError, ChannelPort, ActivityEvent } from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createDigestOnlyRenderer } from "../shared/strategies/digest-only.js";

/**
 * Mint the single-use approval LINK for a `kind:"approval"` event, or `undefined`
 * for any other event. Injected at the daemon composition root: it generates a
 * `generateStrongToken()`, registers it in the gateway approval-token map bound to
 * the event's shortId + choice, and returns the absolute `/approve/:token` URL.
 * The closure never exposes the token or any secret to this renderer beyond the
 * opaque URL it returns.
 */
export type MintApprovalLink = (event: ActivityEvent) => string | undefined;

/** Optional deps for the Email renderer. `mintApprovalLink` wires the APV-10 link. */
export interface EmailActivityRendererDeps {
  mintApprovalLink?: MintApprovalLink;
}

/**
 * Classify a raw Email platform error into the closed {@link ActivityRenderError}
 * union. The live adapter returns a bare nodemailer `Error` on an SMTP send
 * failure with no structured numeric code on the returned value, so this DEFAULTS
 * to `internal` carrying the cause. The error is consulted for NOTHING that
 * reaches the user — it selects the variant only and is never rendered or logged
 * as activity text (SEC-05/§19.3, T-72-04-01).
 */
export function classifyEmailError(e: unknown): ActivityRenderError {
  // The SMTP send path offers no structured code on the returned Error; there is
  // no reliable structural signal to map a richer variant, so internal is the only
  // branch (KISS — do not invent a rich classifier on an unstructured error).
  return { kind: "internal", cause: e };
}

/**
 * Build the {@link ActivityRenderActions} for an Email recipient. `send` posts the
 * digest body (no silent effect, no buttons); `edit` and `delete` are unsupported
 * (Email is send-only) and return `not_supported` without touching the port. All
 * paths return `Result`; nothing throws across the boundary.
 */
export function makeEmailRenderActions(
  adapter: ChannelPort,
  channelId: string,
): ActivityRenderActions {
  return {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      // The digest body: Email ignores any silent effect and has no button surface,
      // so send carries no options. (The reply-threading subject is set by the
      // adapter's own send path, not in this body string.)
      const r = await adapter.sendMessage(channelId, text);
      return r.ok ? ok(r.value) : err(classifyEmailError(r.error));
    },

    async edit(_id, _text): Promise<Result<void, ActivityRenderError>> {
      // Email has no in-place edit — the live adapter exposes no editMessage.
      // DigestOnly never calls this (canEdit:false), but the port contract requires
      // it; an early not_supported is the honest answer (never `adapter.editMessage!`).
      return err({ kind: "not_supported", capability: "edit" });
    },

    async delete(_id): Promise<Result<void, ActivityRenderError>> {
      // Email has no delete — the live adapter exposes no deleteMessage. DigestOnly
      // never calls this (canDelete:false); the early not_supported is the honest
      // answer (never `adapter.deleteMessage!`).
      return err({ kind: "not_supported", capability: "delete" });
    },
  };
}

/**
 * Build the `[FAILED]` digest trailer: the single-use approval LINK for the FIRST
 * `kind:"approval"` event in the trail, or `undefined` when there is none / no
 * minter. Email shows ONE link (the most recent pending approval the failed turn
 * raised); the minter returns `undefined` for non-approval events so a trail with
 * no approval yields no trailer (byte-stable Phase-72 body). The trailer is a
 * single line carrying the opaque URL — never a raw HMAC/secret (T-73-31).
 */
function buildApprovalLinkTrailer(
  trail: readonly ActivityEvent[],
  mintApprovalLink: MintApprovalLink,
): string | undefined {
  for (const event of trail) {
    if (event.approval === undefined) continue;
    const link = mintApprovalLink(event);
    if (link !== undefined && link.length > 0) {
      return `Approve or deny: ${link}`;
    }
  }
  return undefined;
}

/**
 * Create the Email DigestOnly activity renderer — wires the Phase-70
 * {@link createDigestOnlyRenderer} with the per-channel render-actions adapter.
 * DigestOnly is purely end-of-turn, so it takes NO TimerPort / ClockPort (Pitfall
 * 5). The daemon composition root constructs this with the recipient id (WIRE-02)
 * and the optional `mintApprovalLink` accessor (APV-10): when present, a `[FAILED]`
 * digest whose trail carries a `kind:"approval"` event appends the minted
 * single-use link. When absent, the digest is the byte-stable Phase-72 body.
 */
export function createEmailActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: EmailActivityRendererDeps = {},
): ChannelActivityRenderer {
  const { mintApprovalLink } = deps;
  return createDigestOnlyRenderer({
    actions: makeEmailRenderActions(adapter, channelId),
    // Append the APV-10 single-use approval link only when a minter is injected;
    // otherwise the digest stays byte-stable (the 5 golden fixtures are unaffected).
    appendToFailureDigest:
      mintApprovalLink === undefined
        ? undefined
        : (trail) => buildApprovalLinkTrailer(trail, mintApprovalLink),
  });
}
