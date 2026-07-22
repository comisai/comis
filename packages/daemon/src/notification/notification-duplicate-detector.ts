// SPDX-License-Identifier: Apache-2.0
/** Notification-specific configurable duplicate window, separate from heartbeat visibility evidence. */
export interface NotificationDuplicateDetector {
  isDuplicate(key: string, text: string): boolean;
}

export function createNotificationDuplicateDetector(input: {
  ttlMs: number;
  nowMs(): number;
  maxEntries?: number;
}): NotificationDuplicateDetector {
  const maxEntries = input.maxEntries ?? 500;
  const seen = new Map<string, number>();
  return {
    isDuplicate(key, text) {
      const compound = `${Buffer.byteLength(key, "utf8")}:${key}${Buffer.byteLength(text, "utf8")}:${text}`;
      const nowMs = input.nowMs();
      const recordedAtMs = seen.get(compound);
      if (recordedAtMs !== undefined && nowMs - recordedAtMs < input.ttlMs) return true;
      seen.delete(compound);
      while (seen.size >= maxEntries) {
        const oldest = seen.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      seen.set(compound, nowMs);
      return false;
    },
  };
}
