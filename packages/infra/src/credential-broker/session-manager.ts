// SPDX-License-Identifier: Apache-2.0
/**
 * SessionManager — single-use timing-safe proxy token lifecycle.
 *
 * In-memory Map from sessionId → { tokenBuf: Buffer; agentId: string;
 * active: boolean; createdAtMs: number }. Token minted via
 * generateStrongToken() and stored as Buffer for timingSafeEqual.
 *
 * SECURITY: single-use (consumed on first successful request);
 * invalidated on endSession(); TTL reaper at consumeToken() time.
 *
 * @module
 */
import { timingSafeEqual, randomUUID } from "node:crypto";
import { generateStrongToken } from "@comis/core";
import type { ClockPort } from "@comis/core";

// Internal session entry — not exported
interface SessionEntry {
  tokenBuf: Buffer;
  agentId: string;
  active: boolean;
  createdAtMs: number;
}

export interface SessionManagerDeps {
  clock: ClockPort;
  sessionTtlMs?: number; // default: 60 * 60 * 1000 (1 hour)
}

export interface IssuedSession {
  sessionId: string;
  proxyToken: string; // base64url; the token sent to the driven CLI
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
}

export interface SessionManager {
  issueToken(agentId: string): IssuedSession;
  consumeToken(rawToken: string): SessionInfo | null;
  endSession(sessionId: string): void;
}

/**
 * Length-guarded timing-safe buffer comparison.
 * MUST check length equality FIRST — timingSafeEqual throws on unequal lengths.
 */
function tokenEquals(candidate: Buffer, stored: Buffer): boolean {
  if (candidate.length !== stored.length) return false; // length-guard FIRST
  return timingSafeEqual(candidate, stored);
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { clock, sessionTtlMs = 60 * 60 * 1000 } = deps;
  const sessions = new Map<string, SessionEntry>();

  return {
    issueToken(agentId: string): IssuedSession {
      const sessionId = randomUUID();
      const proxyToken = generateStrongToken();
      const tokenBuf = Buffer.from(proxyToken, "base64url");
      sessions.set(sessionId, {
        tokenBuf,
        agentId,
        active: true,
        createdAtMs: clock.now(),
      });
      return { sessionId, proxyToken };
    },

    consumeToken(rawToken: string): SessionInfo | null {
      // Convert attacker-controlled input to Buffer for timing-safe comparison.
      // An empty or malformed base64url string produces an empty or short Buffer —
      // the length-guard in tokenEquals will reject it without throwing.
      const candidateBuf = Buffer.from(rawToken, "base64url");

      for (const [id, entry] of sessions) {
        // Lazy TTL eviction: check expiry at consume time
        if (clock.now() - entry.createdAtMs > sessionTtlMs) {
          sessions.delete(id);
          continue;
        }

        if (!entry.active) {
          continue;
        }

        if (tokenEquals(candidateBuf, entry.tokenBuf)) {
          // Mark as consumed — single-use semantics
          entry.active = false;
          return { sessionId: id, agentId: entry.agentId };
        }
      }

      return null;
    },

    endSession(sessionId: string): void {
      // Delete the entry immediately to prevent unbounded Map growth.
      // Previously this only set active=false, leaving stale entries that
      // would accumulate forever without a subsequent consumeToken scan
      // (the lazy TTL reaper only fires at consume time — CR-04).
      sessions.delete(sessionId);
    },
  };
}
