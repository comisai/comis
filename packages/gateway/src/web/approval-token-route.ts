// SPDX-License-Identifier: Apache-2.0
// @allow-throw: approval-token HTTP route; throws caught by Hono error-handler boundary (web-user-facing flows exception).
/**
 * Email approval-token route for the Comis gateway.
 *
 * Email cannot show interactive buttons, so the `[FAILED]` digest carries a
 * single-use, time-bounded, signed LINK to this route — the token in the URL IS
 * the approval credential. Mounted at `ALL /approve/:token` via
 * `app.route("/approve", createApprovalTokenRoute(deps))`.
 *
 * Single-use invariant: the handler cancels the
 * expiry timer and REMOVES the pending-token entry at the TOP — BEFORE deciding
 * the outcome and REGARDLESS of HTTP method. A mail client's preview/HEAD
 * prefetch is therefore a use: a following GET finds a dead token. Even when the
 * resolution path errors AFTER the revoke, the token is already gone — no
 * reusable state. The resolution itself is delegated to an injected
 * `resolveApproval` callback (wired at the daemon composition root to the
 * orchestrator's InteractiveCallbackRouter / ApprovalGate) so this route — and
 * the whole gateway package — never imports `@comis/orchestrator`.
 *
 * 5-min auto-expiry: `insertPendingApprovalToken` schedules a
 * `systemSetTimeout` delete after APPROVAL_TOKEN_TIMEOUT_MS (approvals also
 * default `approvals.defaultTimeoutMs: 300_000`). The token is minted via
 * `generateStrongToken()` (384-bit) at the composition root.
 *
 * Logging discipline: `submodule: "approval-token"` on every line;
 * NEVER log the token or any secret. Time/timers come from `@comis/core`
 * (`systemNowMs`/`systemSetTimeout`/`systemClearTimeout`) — no `Date.now()` /
 * `setTimeout` globals (AGENTS.md §2.8).
 *
 * @module
 */

import { Hono } from "hono";
import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ConversationRef, SystemTimeoutHandle } from "@comis/core";
import type { GatewayLogger } from "../server/gateway-logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 5-minute pending-token expiry. Exported for test parity (mirrors PENDING_FLOW_TIMEOUT_MS). */
export const APPROVAL_TOKEN_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The approval choice an email link encodes. Email surfaces approve/deny only. */
export type ApprovalLinkChoice = "approve" | "deny";

/**
 * A pending single-use approval token entry, keyed by the opaque token string.
 * Created by `insertPendingApprovalToken` at digest-render time; consumed (and
 * removed) by the route handler on the first touch of `/approve/:token`.
 *
 * Carries ONLY the server-side correlation needed to resolve the approval — the
 * shortId, the chosen outcome, and the originating authority/channel so the
 * injected resolver can route it. The full pending-request UUID never appears.
 */
export interface PendingApprovalToken {
  /** 12-char base62 shortId minted by the approval gate (§6.4.1). */
  shortId: string;
  /** The outcome this link encodes (approve/deny). */
  choice: ApprovalLinkChoice;
  tenantId: string;
  conversationRef: ConversationRef;
  resolvingPrincipalId: string;
  inboundUserId: string;
  threadId?: string;
  /** Originating channel type (e.g. "email"). */
  channelType: string;
  /** Originating channel key (recipient id). */
  channelKey: string;
  /** Owning agent id. */
  agentId: string;
  /** Auto-expiry timer; the handler clears it on consume. */
  timer: SystemTimeoutHandle;
}

/** Dependencies for createApprovalTokenRoute. */
export interface ApprovalTokenDeps {
  /** Token -> PendingApprovalToken map; mutated by the handler + insertPendingApprovalToken. */
  readonly tokens: Map<string, PendingApprovalToken>;
  /**
   * Resolve the approval for a consumed token. Injected at the daemon composition
   * root (delegates to the InteractiveCallbackRouter / ApprovalGate). Returns
   * `true` when the approval was resolved, `false` when it could not be (already
   * resolved, expired server-side, cross-session). Called AFTER the token is
   * already revoked, so a throw/false never re-arms the token.
   */
  readonly resolveApproval: (entry: PendingApprovalToken) => Promise<boolean>;
  /** Gateway-scoped logger. */
  readonly logger: GatewayLogger;
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

function approvalHtml(title: string, heading: string, message: string, color: string): string {
  return [
    "<!DOCTYPE html>",
    `<html><head><meta charset="utf-8"><title>${title}</title>`,
    `<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8em auto;padding:2em;text-align:center;color:#222}h1{color:${color}}</style>`,
    `</head><body><h1>${heading}</h1>`,
    `<p>${message}</p>`,
    "<p>You can close this window.</p>",
    "</body></html>",
  ].join("");
}

const RESOLVED_HTML = approvalHtml(
  "Approval Recorded",
  "Approval Recorded",
  "Your response has been recorded.",
  "#0a7d2c",
);

const INVALID_HTML = approvalHtml(
  "Link Expired",
  "Link Expired",
  "This approval link is invalid, already used, or has expired.",
  "#b00020",
);

const ERROR_HTML = approvalHtml(
  "Could Not Record",
  "Could Not Record",
  "The link was consumed but the approval could not be recorded. It cannot be retried.",
  "#b00020",
);

// ---------------------------------------------------------------------------
// Public boundary
// ---------------------------------------------------------------------------

/**
 * Seed the token map with a new token -> PendingApprovalToken entry, scheduling a
 * 5-minute auto-delete cleanup timer.
 *
 * The caller is responsible for generating `token` via `generateStrongToken()`
 * (384-bit) — never hand-roll a PRNG. The timer NEVER logs the token.
 */
export function insertPendingApprovalToken(
  map: Map<string, PendingApprovalToken>,
  token: string,
  entry: Omit<PendingApprovalToken, "timer">,
  logger: GatewayLogger,
): void {
  const timer = systemSetTimeout(() => {
    map.delete(token);
    logger.debug(
      {
        shortId: entry.shortId,
        channelType: entry.channelType,
        submodule: "approval-token",
      },
      "Pending approval token expired",
    );
  }, APPROVAL_TOKEN_TIMEOUT_MS);
  map.set(token, { ...entry, timer });
}

/**
 * Create the approval-token Hono sub-app.
 *
 * Mount via:
 *   const app = new Hono();
 *   app.route("/approve", createApprovalTokenRoute(deps));
 * Resulting URL: ALL /approve/:token
 *
 * `app.all` matches every HTTP method (GET, HEAD, …) so a mail-client preview
 * prefetch consumes the token exactly like a real click — the revoke-on-first-
 * touch invariant holds regardless of method.
 */
export function createApprovalTokenRoute(deps: ApprovalTokenDeps): Hono {
  const app = new Hono();

  app.all("/:token", async (c) => {
    const token = c.req.param("token");

    // Revoke FIRST, regardless of method. A
    // preview/HEAD prefetch consumes the token; an errored resolution below
    // still leaves no reusable state because the entry is already gone.
    const entry = deps.tokens.get(token);
    if (entry === undefined) {
      // Unknown / already-consumed / expired token. No log of the token itself.
      return c.html(INVALID_HTML, 410);
    }
    systemClearTimeout(entry.timer);
    deps.tokens.delete(token);

    try {
      const resolved = await deps.resolveApproval(entry);
      if (!resolved) {
        // The token was valid + consumed, but the server-side approval was no
        // longer resolvable (already resolved elsewhere, expired, cross-session).
        deps.logger.info(
          {
            shortId: entry.shortId,
            channelType: entry.channelType,
            submodule: "approval-token",
          },
          "Approval token consumed but not resolvable",
        );
        return c.html(INVALID_HTML, 410);
      }
      deps.logger.info(
        {
          shortId: entry.shortId,
          choice: entry.choice,
          channelType: entry.channelType,
          submodule: "approval-token",
        },
        "Approval recorded via email link",
      );
      return c.html(RESOLVED_HTML);
    } catch {
      // The token is already revoked above — no retry is possible.
      // Never log the caught error verbatim (it could echo request internals).
      deps.logger.warn(
        {
          shortId: entry.shortId,
          channelType: entry.channelType,
          errorKind: "internal" as const,
          hint: "Approval resolution threw; the single-use token is already consumed and cannot be retried.",
          submodule: "approval-token",
        },
        "Approval token resolution failed",
      );
      // The token is already irrevocably consumed above, so this is a
      // CONSUMED-but-failed terminal state, not a transient server error. Return a
      // non-retryable 409 (not 500 — the conventional "retry me" signal) so the
      // status line agrees with the ERROR_HTML "cannot be retried" body copy and a
      // mail-client prefetch that trips this path never invites a user retry.
      return c.html(ERROR_HTML, 409);
    }
  });

  return app;
}
