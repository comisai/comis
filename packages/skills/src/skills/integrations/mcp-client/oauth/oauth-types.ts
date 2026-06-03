// SPDX-License-Identifier: Apache-2.0
/**
 * Shared OAuth orchestration types — the structural shapes that both
 * `runOauthLogin` (PKCE path, `./login.ts`) and `runDeviceFlow` (RFC 8628
 * path, `./device-flow.ts`) consume.
 *
 * Owns ZERO runtime: pure type-shape contracts so neither orchestrator file
 * imports the other for type purposes (the runtime dispatch direction is
 * one-way: `login.ts` → `device-flow.ts`). Splitting these types into this
 * file breaks the intra-package source-level cycle that an
 * `import type { ... } from "./login.js"` from `device-flow.ts` would
 * otherwise create (madge source mode counts type-only imports as edges).
 *
 * @module
 */

/** Structural logger contract — matches token-store / discovery / deduper. */
export interface OAuthLoginLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** Per-server OAuth hints (a structural subset of `McpServerConfig["oauth"]`).
 *  Kept local so this module does not depend on the manager types. */
export interface OAuthLoginConfig {
  /** Discovery-cascade fallback authorization-server URL. */
  readonly authorizationEndpoint?: string;
  /** RFC 8628 device-authorization endpoint operator override. Consumed by
   *  `runDeviceFlow`'s discovery cascade when the resolved metadata lacks
   *  `device_authorization_endpoint` (Higgsfield reality 2026-05-28). Wins
   *  over the auto-resolved endpoint when both are present. See
   *  `McpServerEntrySchema.oauth.deviceAuthorizationEndpoint`. */
  readonly deviceAuthorizationEndpoint?: string;
  /** Per-server flow override that beats the headless heuristic.
   *  `"device_code"` forces RFC 8628; `"auth_code"` forces PKCE+loopback.
   *  Absent ⇒ `runOauthLogin` chooses by the heuristic (headless ∧ device-
   *  code-advertised → device-flow). */
  readonly flow?: "device_code" | "auth_code";
  /** Requested OAuth scope (threaded into clientMetadata + DCR + auth()). */
  readonly scope?: string;
  /** Stripe Connect connected-account id. */
  readonly stripeAccount?: string;
}

/** The login orchestration result returned to the RPC handler.
 *  `authorized` — code exchanged + tokens persisted (caller reconnects).
 *  `headless_hint` — PKCE: forward the port + open `authUrl` yourself.
 *  `device_code_pending` — RFC 8628: surface `verificationUri` + `userCode`
 *    to operator; daemon polls in background + fires `onAuthorized` on success.
 *  `failed` — discovery / callback / exchange / device-flow polling failed. */
export interface OAuthLoginResult {
  readonly status: "authorized" | "headless_hint" | "device_code_pending" | "failed";
  /** Present on `headless_hint`: `ssh -L <port>:localhost:<port> <vps>`. */
  readonly portForwardHint?: string;
  /** Authorization URL for the CLI to open. Present on `headless_hint` and the
   *  non-headless path. Pitfall 8: distinct from `verificationUri` (PKCE
   *  loopback-redirect URL vs. RFC 8628 user-typed URL — do NOT collapse). */
  readonly authUrl?: string;
  /** RFC 8628 §3.3.1 operator-facing verification URL. Present on
   *  `device_code_pending`. Non-secret. */
  readonly verificationUri?: string;
  /** RFC 8628 §3.2 short human-readable code (e.g. `"WDJB-MJHT"`). Present on
   *  `device_code_pending`. Non-secret; surfaced via agent's `message` tool. */
  readonly userCode?: string;
  /** RFC 8628 §3.2 seconds until `device_code` expires. Present on
   *  `device_code_pending`. Informational; deadline enforced in `runDeviceFlow`. */
  readonly expiresIn?: number;
}
