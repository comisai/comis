// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { err, ok } from "@comis/shared";
import type { ZodError, ZodType } from "zod";

/** Validation failure returned by a typed SQLite row mapper. */
export interface MapperError {
  readonly code: "row-validation-failed";
  readonly message: string;
  readonly path: string;
  readonly issues: readonly { path: (string | number)[]; message: string }[];
}

/** Result-returning parser for `Statement.get()` and `Statement.all()` output. */
export interface RowMapper<TRow> {
  parseOptionalRow(raw: unknown | undefined): Result<TRow | undefined, MapperError>;
  parseRows(raw: unknown[]): Result<TRow[], MapperError>;
}

function issuesFromZod(
  zodError: ZodError,
): readonly { path: (string | number)[]; message: string }[] {
  return zodError.issues.map((issue) => ({
    path: issue.path as (string | number)[],
    message: issue.message,
  }));
}

/** Build a typed, non-throwing SQLite row mapper from a Zod schema. */
export function createRowMapper<TRow>(schema: ZodType<TRow>): RowMapper<TRow> {
  return {
    parseOptionalRow(raw) {
      if (raw === undefined) return ok(undefined);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issues = issuesFromZod(parsed.error);
        const path = issues[0]?.path.join(".") ?? "<root>";
        return err({
          code: "row-validation-failed",
          message: `Row validation failed at ${path}`,
          path,
          issues,
        });
      }
      return ok(parsed.data);
    },
    parseRows(raw) {
      const rows: TRow[] = [];
      for (let index = 0; index < raw.length; index++) {
        const parsed = schema.safeParse(raw[index]);
        if (!parsed.success) {
          const issues = issuesFromZod(parsed.error);
          const firstIssuePath = issues[0]?.path.join(".") ?? "<root>";
          const path = `row[${index}].${firstIssuePath}`;
          return err({
            code: "row-validation-failed",
            message: `Row validation failed at ${path}`,
            path,
            issues,
          });
        }
        rows.push(parsed.data);
      }
      return ok(rows);
    },
  };
}
