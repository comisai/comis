// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Schema initialization cannot safely continue when SQLite returns malformed PRAGMA metadata; daemon bootstrap owns the boundary and aborts startup.
import { z } from "zod";
import { createRowMapper } from "./sqlite-row-mapper.js";

const TableInfoRowSchema = z.strictObject({
  cid: z.number().int().nonnegative(),
  name: z.string(),
  type: z.string(),
  notnull: z.number().int().nonnegative(),
  dflt_value: z.string().nullable(),
  pk: z.number().int().nonnegative(),
});

export type TableInfoRow = z.infer<typeof TableInfoRowSchema>;

const tableInfoMapper = createRowMapper(TableInfoRowSchema);

/**
 * Validate a `PRAGMA table_info(...)` result before schema code makes DDL
 * decisions from it. A malformed schema projection is a startup precondition
 * failure: continuing could repeat an ALTER or omit a required column.
 */
export function requireTableInfoRows(raw: unknown[], tableName: string): TableInfoRow[] {
  const parsed = tableInfoMapper.parseRows(raw);
  if (!parsed.ok) {
    throw new Error(`Schema inspection failed for ${tableName} at ${parsed.error.path}`);
  }
  return parsed.value;
}
