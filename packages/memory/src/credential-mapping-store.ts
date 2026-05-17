// SPDX-License-Identifier: Apache-2.0
// @allow-throw: validation throw inside tryCatch() boundary wrapper (CredentialMappingPort.set); SQLite-backed adapter rethrows are caught and converted to Result by the port-internal tryCatch + caller via daemon RPC handler @allow-throw boundary.
/**
 * CredentialMappingStore — CredentialMappingPort implementation with SQLite storage.
 *
 * Factory function pattern: initializes schema, prepares all SQL statements once,
 * and returns a frozen CredentialMappingPort object. Maps between camelCase domain
 * fields and snake_case database columns.
 *
 * Persists credential-to-injection bindings alongside encrypted secrets.
 */

import type Database from "better-sqlite3";
import type { z } from "zod";
import { err, tryCatch } from "@comis/shared";
import type { CredentialMappingPort, CredentialMapping } from "@comis/core";
import { initCredentialMappingSchema } from "./credential-mapping-schema.js";
import { createRowMapper } from "./row-mapper.js";
import { CredentialMappingRowSchema } from "./row-schemas.js";

/**
 * Row shape returned by SELECT queries on the credential_mappings table.
 * SSOT is `CredentialMappingRowSchema` in row-schemas.ts.
 */
type CredentialMappingRow = z.infer<typeof CredentialMappingRowSchema>;
const credentialMappingMapper = createRowMapper(CredentialMappingRowSchema);

/**
 * Convert a snake_case database row to a camelCase CredentialMapping domain object.
 */
function rowToMapping(row: CredentialMappingRow): CredentialMapping {
  return {
    id: row.id,
    secretName: row.secret_name,
    injectionType: row.injection_type as CredentialMapping["injectionType"],
    injectionKey: row.injection_key ?? undefined,
    urlPattern: row.url_pattern,
    toolName: row.tool_name ?? undefined,
  };
}

/**
 * Create a CredentialMappingStore bound to the given database.
 *
 * The database must already have the `secrets` table (from initSecretSchema).
 * This factory calls initCredentialMappingSchema (idempotent) to ensure the
 * credential_mappings table and indexes exist.
 *
 * @param db - An open better-sqlite3 Database instance with secrets table
 * @returns CredentialMappingPort implementation
 */
export function createCredentialMappingStore(db: Database.Database): CredentialMappingPort {
  // Idempotent schema initialization
  initCredentialMappingSchema(db);

  // Prepare all SQL statements once
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO credential_mappings (id, secret_name, injection_type, injection_key, url_pattern, tool_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const getByIdStmt = db.prepare(
    "SELECT id, secret_name, injection_type, injection_key, url_pattern, tool_name FROM credential_mappings WHERE id = ?",
  );

  const listAllStmt = db.prepare(
    "SELECT id, secret_name, injection_type, injection_key, url_pattern, tool_name FROM credential_mappings",
  );

  const listBySecretStmt = db.prepare(
    "SELECT id, secret_name, injection_type, injection_key, url_pattern, tool_name FROM credential_mappings WHERE secret_name = ?",
  );

  const listByToolStmt = db.prepare(
    "SELECT id, secret_name, injection_type, injection_key, url_pattern, tool_name FROM credential_mappings WHERE tool_name = ?",
  );

  const deleteByIdStmt = db.prepare(
    "DELETE FROM credential_mappings WHERE id = ?",
  );

  const store: CredentialMappingPort = {
    set(mapping: CredentialMapping) {
      return tryCatch(() => {
        // Validate urlPattern is a valid regex at storage time
        try {
          new RegExp(mapping.urlPattern);
        } catch (regexErr: unknown) {
          const msg = regexErr instanceof Error ? regexErr.message : String(regexErr);
          throw new Error(`Invalid urlPattern "${mapping.urlPattern}": ${msg}`, { cause: regexErr });
        }

        upsertStmt.run(
          mapping.id,
          mapping.secretName,
          mapping.injectionType,
          mapping.injectionKey ?? null,
          mapping.urlPattern,
          mapping.toolName ?? null,
        );
      });
    },

    get(id: string) {
      const parsed = credentialMappingMapper.parseOptionalRow(getByIdStmt.get(id));
      if (!parsed.ok) {
        return err(new Error(`Row validation failed: ${parsed.error.message}`));
      }
      return tryCatch(() => {
        const row = parsed.value;
        if (!row) {
          return undefined;
        }
        return rowToMapping(row);
      });
    },

    listAll() {
      const parsed = credentialMappingMapper.parseRows(listAllStmt.all());
      if (!parsed.ok) {
        return err(new Error(`Row validation failed: ${parsed.error.message}`));
      }
      return tryCatch(() => {
        return parsed.value.map(rowToMapping);
      });
    },

    listBySecret(secretName: string) {
      const parsed = credentialMappingMapper.parseRows(listBySecretStmt.all(secretName));
      if (!parsed.ok) {
        return err(new Error(`Row validation failed: ${parsed.error.message}`));
      }
      return tryCatch(() => {
        return parsed.value.map(rowToMapping);
      });
    },

    listByTool(toolName: string) {
      const parsed = credentialMappingMapper.parseRows(listByToolStmt.all(toolName));
      if (!parsed.ok) {
        return err(new Error(`Row validation failed: ${parsed.error.message}`));
      }
      return tryCatch(() => {
        return parsed.value.map(rowToMapping);
      });
    },

    delete(id: string) {
      return tryCatch(() => {
        const result = deleteByIdStmt.run(id);
        return result.changes > 0;
      });
    },
  };

  return Object.freeze(store);
}
