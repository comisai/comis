// SPDX-License-Identifier: Apache-2.0
/** Human-readable labels stored in authority-scoped session metadata. */

import type {
  ConversationRef,
  ConversationScope,
  SessionQueryScope,
  SessionStoreError,
  SessionStorePort,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";

export interface SessionLabelStore {
  getLabel(scope: ConversationScope): Result<string | undefined, SessionStoreError>;
  setLabel(scope: ConversationScope, label: string): Result<void, SessionStoreError>;
  removeLabel(scope: ConversationScope): Result<void, SessionStoreError>;
  listLabeled(scope: SessionQueryScope): Result<Array<{ conversationRef: ConversationRef; label: string }>, SessionStoreError>;
}

export function createSessionLabelStore(store: SessionStorePort): SessionLabelStore {
  return {
    getLabel(scope) {
      const loaded = store.load(scope);
      if (!loaded.ok) return loaded;
      const label = loaded.value?.metadata.label;
      return ok(typeof label === "string" ? label : undefined);
    },

    setLabel(scope, label) {
      const loaded = store.load(scope);
      if (!loaded.ok) return loaded;
      if (loaded.value === undefined) return ok(undefined);
      return store.save(scope, loaded.value.messages, { ...loaded.value.metadata, label });
    },

    removeLabel(scope) {
      const loaded = store.load(scope);
      if (!loaded.ok) return loaded;
      if (loaded.value === undefined) return ok(undefined);
      const { label: _label, ...metadata } = loaded.value.metadata;
      return store.save(scope, loaded.value.messages, metadata);
    },

    listLabeled(scope) {
      const listed = store.listDetailed(scope);
      if (!listed.ok) return listed;
      const result: Array<{ conversationRef: ConversationRef; label: string }> = [];
      for (const entry of listed.value) {
        const label = entry.metadata.label;
        if (typeof label === "string") result.push({ conversationRef: entry.conversationRef, label });
      }
      return ok(result);
    },
  };
}
