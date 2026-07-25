// SPDX-License-Identifier: Apache-2.0
/** Explicit ephemeral adapter for deployments that intentionally omit durable context storage. */
import type { ContextStorePort } from "@comis/core";
import { tryCatch, type Result } from "@comis/shared";
import Database from "better-sqlite3";
import { createLcdStore } from "./lcd-store.js";
import { initSchema } from "./schema.js";

export interface InMemoryContextStoreHandle {
  contextStore: ContextStorePort;
  close(): Result<void, Error>;
}

export function createInMemoryContextStore(): Result<InMemoryContextStoreHandle, Error> {
  let database: Database.Database | undefined;
  const created = tryCatch((): InMemoryContextStoreHandle => {
    database = new Database(":memory:");
    initSchema(database, 1536);
    const contextStore = createLcdStore(database);
    let closed = false;
    return {
      contextStore,
      close: () => tryCatch(() => {
        if (closed) return;
        database?.close();
        closed = true;
      }),
    };
  });
  if (!created.ok && database !== undefined) void tryCatch(() => database?.close());
  return created;
}
