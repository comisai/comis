// SPDX-License-Identifier: Apache-2.0
/**
 * ACP Session Map — maps ACP session IDs to Comis SessionKey triples.
 *
 * Each ACP session (created by an IDE client) is assigned an Comis-compatible
 * session key with channelId "acp", userId "ide-user", and peerId set to the
 * ACP session ID. This follows the channel adapter pattern where each protocol
 * gets a dedicated channelId.
 */

/**
 * Minimal SessionKey triple used for ACP session mapping.
 * Matches the subset of core's SessionKey needed for agent execution.
 */
export interface AcpSessionKey {
  readonly userId: string;
  readonly channelId: string;
  readonly peerId: string;
}

/**
 * Maps ACP session IDs to Comis SessionKey triples.
 */
export interface AcpSessionMap {
  /** Create and store a SessionKey for the given ACP session ID. */
  create(acpSessionId: string): AcpSessionKey;
  /** Retrieve the SessionKey for the given ACP session ID, or undefined if not found. */
  get(acpSessionId: string): AcpSessionKey | undefined;
  /** Remove the mapping for the given ACP session ID. Returns true if it existed. */
  remove(acpSessionId: string): boolean;
  /** Return a snapshot of all active session mappings. */
  getAll(): ReadonlyMap<string, AcpSessionKey>;
  /** Remove all session mappings. */
  clear(): void;
}

/**
 * Create an ACP session map that tracks ACP-to-Comis session mappings.
 *
 * Uses channelId "acp", userId "ide-user", and peerId = acpSessionId,
 * following the convention for IDE integration sessions.
 */
export function createAcpSessionMap(maxSessions: number = 1000): AcpSessionMap {
  const sessions = new Map<string, AcpSessionKey>();

  return {
    create(acpSessionId: string): AcpSessionKey {
      // Evict oldest session when at capacity
      if (sessions.size >= maxSessions) {
        // Map iteration order is insertion order -- first key is oldest
        const oldestKey = sessions.keys().next().value;
        if (oldestKey !== undefined) {
          sessions.delete(oldestKey);
        }
      }

      const sessionKey: AcpSessionKey = {
        userId: "ide-user",
        channelId: "acp",
        peerId: acpSessionId,
      };
      sessions.set(acpSessionId, sessionKey);
      return sessionKey;
    },

    get(acpSessionId: string): AcpSessionKey | undefined {
      return sessions.get(acpSessionId);
    },

    remove(acpSessionId: string): boolean {
      return sessions.delete(acpSessionId);
    },

    getAll(): ReadonlyMap<string, AcpSessionKey> {
      // Return a snapshot to prevent external mutation (per 63-06 decision)
      return new Map(sessions);
    },

    clear(): void {
      sessions.clear();
    },
  };
}
