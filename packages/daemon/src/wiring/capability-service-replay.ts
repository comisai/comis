// SPDX-License-Identifier: Apache-2.0
const MAX_REPLAY_ENTRIES = 4_096;

export function pruneCapabilityServiceReplayEntries<T extends {
  readonly response?: unknown;
  readonly retryable?: boolean;
}>(replay: Map<string, T>, maxEntries = MAX_REPLAY_ENTRIES): void {
  while (replay.size > maxEntries) {
    const removable = [...replay.entries()].find(([, entry]) => (
      entry.response !== undefined || entry.retryable === true
    ));
    if (removable === undefined) return;
    replay.delete(removable[0]);
  }
}
