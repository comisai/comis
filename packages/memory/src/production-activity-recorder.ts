// SPDX-License-Identifier: Apache-2.0
import type { ProductionActivityRecorderPort } from "@comis/core";
import { err, tryCatch, type Result } from "@comis/shared";

import { openSqliteDatabase } from "./sqlite-adapter-base.js";
import { sha256 } from "./production-activity-recorder-integrity.js";
import { createSqliteProductionActivityRecorderOnDatabase } from "./production-activity-recorder-store.js";
import {
  type OpenSqliteProductionActivityRecorderOptions,
  validLimits,
} from "./production-activity-recorder-support.js";

export type {
  ActivityRecorderLimits,
  CreateSqliteProductionActivityRecorderOptions,
  OpenSqliteProductionActivityRecorderOptions,
} from "./production-activity-recorder-support.js";
export { createSqliteProductionActivityRecorderOnDatabase };

export function openSqliteProductionActivityRecorder(
  options: OpenSqliteProductionActivityRecorderOptions,
): Result<ProductionActivityRecorderPort, Error> {
  const opened = tryCatch(() => openSqliteProductionActivityRecorderUnchecked(options));
  return opened.ok ? opened.value : opened;
}

function openSqliteProductionActivityRecorderUnchecked(
  options: OpenSqliteProductionActivityRecorderOptions,
): Result<ProductionActivityRecorderPort, Error> {
  if (!validLimits(options.limits)) return err(new Error("Invalid activity recorder limits"));
  const streamId = options.streamId ?? sha256([Buffer.from(options.dbPath, "utf8")]);
  const opened = tryCatch(() => {
    const db = openSqliteDatabase({
      dbPath: options.dbPath,
      walMode: true,
      busyTimeoutMs: options.limits.busyTimeoutMs ?? 5_000,
    });
    db.pragma("synchronous = FULL");
    db.pragma("secure_delete = ON");
    db.pragma(`busy_timeout = ${options.limits.busyTimeoutMs ?? 5_000}`);
    const pageSize = Number(db.pragma("page_size", { simple: true }));
    const maxPages = Math.max(32, Math.ceil(options.limits.maxStoredBytes / pageSize) + 16);
    db.pragma(`max_page_count = ${maxPages}`);
    return db;
  });
  if (!opened.ok) return opened;
  const created = createSqliteProductionActivityRecorderOnDatabase({
    ...options,
    streamId,
    db: opened.value,
    closeDatabase: true,
  });
  if (!created.ok) void tryCatch(() => opened.value.close());
  return created;
}
