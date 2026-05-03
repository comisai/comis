// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth identity extraction for Codex JWTs.
 *
 * Decodes the access-token JWT payload (no signature verification — pi-ai's
 * token exchange validated the source) and resolves the canonical identity
 * for use in profile IDs.
 *
 * Verbatim port of OpenClaw's openai-codex-auth-identity.ts (RESEARCH Q5)
 * plus the D-14 email-redaction helper.
 *
 * @module
 */

const PROFILE_CLAIM_NS = "https://api.openai.com/profile";

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Decode the payload segment of a JWT.
 * Returns null on any malformed input (wrong segment count, bad base64url,
 * invalid JSON, non-object payload). Returning null is a sentinel, not
 * silent error swallowing.
 */
export function decodeCodexJwtPayload(accessToken: string): Record<string, unknown> | null {
  if (typeof accessToken !== "string") return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical stable subject for fallback profile naming.
 * Priority: chatgpt_account_user_id > chatgpt_user_id > user_id > iss|sub > sub.
 */
export function resolveCodexStableSubject(payload: Record<string, unknown>): string | undefined {
  const candidates: Array<string | undefined> = [
    trimNonEmptyString(payload.chatgpt_account_user_id),
    trimNonEmptyString(payload.chatgpt_user_id),
    trimNonEmptyString(payload.user_id),
    (() => {
      const iss = trimNonEmptyString(payload.iss);
      const sub = trimNonEmptyString(payload.sub);
      if (iss && sub) return iss + "|" + sub;
      return undefined;
    })(),
    trimNonEmptyString(payload.sub),
  ];
  for (const c of candidates) if (c) return c;
  return undefined;
}

/**
 * Resolve the canonical email + profileName for a Codex identity.
 * Priority for email: explicit `opts.email` > JWT `https://api.openai.com/profile.email`.
 * profileName = email when available, else `id-<base64url(stableSubject)>`.
 */
export function resolveCodexAuthIdentity(opts: {
  accessToken: string;
  email?: string;
}): { email?: string; profileName?: string } {
  const explicit = trimNonEmptyString(opts.email);
  const payload = decodeCodexJwtPayload(opts.accessToken);

  let email: string | undefined = explicit;
  if (!email && payload) {
    // eslint-disable-next-line security/detect-object-injection -- PROFILE_CLAIM_NS is a literal module constant, not user input
    const profile = payload[PROFILE_CLAIM_NS];
    if (profile !== null && typeof profile === "object" && !Array.isArray(profile)) {
      email = trimNonEmptyString((profile as Record<string, unknown>).email);
    }
  }

  if (email) return { email, profileName: email };

  if (payload) {
    const subject = resolveCodexStableSubject(payload);
    if (subject) {
      const subjectB64 = Buffer.from(subject, "utf8").toString("base64url");
      return { email: undefined, profileName: "id-" + subjectB64 };
    }
  }

  return { email: undefined, profileName: undefined };
}

/**
 * Extract the access-token expiry as milliseconds since epoch.
 * The JWT exp claim is in seconds (RFC 7519); we multiply by 1000 to match
 * pi-ai's OAuthCredentials.expires unit (ms — RESEARCH Q1 landmine 4).
 * Accepts numeric `exp` and digit-only string `exp`.
 */
export function resolveCodexAccessTokenExpiry(accessToken: string): number | undefined {
  const payload = decodeCodexJwtPayload(accessToken);
  if (!payload) return undefined;
  const expRaw = payload.exp;
  let expSec: number | undefined;
  if (typeof expRaw === "number" && Number.isFinite(expRaw)) {
    expSec = expRaw;
  } else if (typeof expRaw === "string" && /^\d+$/.test(expRaw)) {
    expSec = Number(expRaw);
  }
  if (expSec === undefined) return undefined;
  return expSec * 1000;
}

/**
 * Semi-redact an email for safe inclusion in logs (D-14).
 * Format: first 2 chars + ellipsis + last char of local-part, then "@" + full domain.
 * Edge cases:
 *  - undefined input → undefined
 *  - input without "@" → returned unchanged
 *  - 1-char local-part → "…@<domain>"
 *  - 2-char local-part → "<first>…<last>@<domain>" (single char on each side)
 */
export function redactEmailForLog(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return email;
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  if (local.length === 0) return email;
  if (local.length === 1) return "…@" + domain;
  if (local.length === 2) return local.charAt(0) + "…" + local.charAt(1) + "@" + domain;
  return local.slice(0, 2) + "…" + local.charAt(local.length - 1) + "@" + domain;
}
