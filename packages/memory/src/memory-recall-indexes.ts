// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { z } from "zod";
import { reconcileVecTableDimension, type VecTableRebuild } from "./vec-dimension.js";

const SchemaRowSchema = z.strictObject({ sql: z.string().nullable() });

function schemaSql(db: Database.Database, name: string): string | undefined {
  const parsed = SchemaRowSchema.safeParse(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name),
  );
  return parsed.success ? (parsed.data.sql ?? undefined) : undefined;
}

function ensureAuthorityTable(db: Database.Database): void {
  const existingSql = schemaSql(db, "memory_authority_partitions");
  if (existingSql !== undefined && !/visibility_key/i.test(existingSql)) {
    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TRIGGER IF EXISTS memories_tri_ad;
      DROP TRIGGER IF EXISTS memories_tri_au;
      DROP TABLE IF EXISTS memory_fts;
      DROP TABLE IF EXISTS memory_fts_tri;
      DROP TABLE IF EXISTS vec_memories;
      DROP TABLE memory_authority_partitions;
      UPDATE memories SET has_embedding = 0;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_authority_partitions (
      partition_id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      visibility_key TEXT NOT NULL,
      UNIQUE (tenant_id, agent_id, visibility_key)
    );
    INSERT OR IGNORE INTO memory_authority_partitions (tenant_id, agent_id, visibility_key)
      SELECT DISTINCT tenant_id, agent_id,
        CASE visibility
          WHEN 'conversation' THEN 'conversation:' || conversation_ref
          WHEN 'principal' THEN 'principal:' || principal_id
          ELSE 'agent-shared'
        END
      FROM memories;
  `);
}

function ensureVectorIndex(
  db: Database.Database,
  embeddingDimensions: number,
): VecTableRebuild[] {
  const rebuilt: VecTableRebuild[] = [];
  const fromDimensions = reconcileVecTableDimension(db, "vec_memories", embeddingDimensions);
  if (fromDimensions !== undefined) {
    db.exec("UPDATE memories SET has_embedding = 0");
    rebuilt.push({
      table: "vec_memories",
      fromDimensions,
      toDimensions: embeddingDimensions,
    });
  }

  const existingSql = schemaSql(db, "vec_memories");
  if (existingSql !== undefined && !/authority_partition_id\s+INTEGER\s+PARTITION\s+KEY/i.test(existingSql)) {
    db.exec("DROP TABLE vec_memories; UPDATE memories SET has_embedding = 0;");
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${embeddingDimensions}] distance_metric=cosine,
      authority_partition_id INTEGER PARTITION KEY
    );
  `);
  return rebuilt;
}

function ensureWordIndex(db: Database.Database): void {
  const existingSql = schemaSql(db, "memory_fts");
  const needsRebuild = existingSql === undefined || !/authority_token/i.test(existingSql);
  if (needsRebuild) {
    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memory_fts;
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        content,
        authority_token,
        tokenize='porter unicode61'
      );
      INSERT INTO memory_fts(rowid, content, authority_token)
        SELECT m.rowid, m.content, 'authority_' || p.partition_id
        FROM memories m
        JOIN memory_authority_partitions p
          ON p.tenant_id = m.tenant_id AND p.agent_id = m.agent_id
         AND p.visibility_key = CASE m.visibility
           WHEN 'conversation' THEN 'conversation:' || m.conversation_ref
           WHEN 'principal' THEN 'principal:' || m.principal_id
           ELSE 'agent-shared'
         END;
    `);
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT OR IGNORE INTO memory_authority_partitions (tenant_id, agent_id, visibility_key)
        VALUES (new.tenant_id, new.agent_id, CASE new.visibility
          WHEN 'conversation' THEN 'conversation:' || new.conversation_ref
          WHEN 'principal' THEN 'principal:' || new.principal_id
          ELSE 'agent-shared'
        END);
      INSERT INTO memory_fts(rowid, content, authority_token)
        SELECT new.rowid, new.content, 'authority_' || partition_id
        FROM memory_authority_partitions
        WHERE tenant_id = new.tenant_id AND agent_id = new.agent_id
          AND visibility_key = CASE new.visibility
            WHEN 'conversation' THEN 'conversation:' || new.conversation_ref
            WHEN 'principal' THEN 'principal:' || new.principal_id
            ELSE 'agent-shared'
          END;
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memory_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au
      AFTER UPDATE OF content, tenant_id, agent_id, visibility, conversation_ref, principal_id ON memories BEGIN
      DELETE FROM memory_fts WHERE rowid = old.rowid;
      INSERT OR IGNORE INTO memory_authority_partitions (tenant_id, agent_id, visibility_key)
        VALUES (new.tenant_id, new.agent_id, CASE new.visibility
          WHEN 'conversation' THEN 'conversation:' || new.conversation_ref
          WHEN 'principal' THEN 'principal:' || new.principal_id
          ELSE 'agent-shared'
        END);
      INSERT INTO memory_fts(rowid, content, authority_token)
        SELECT new.rowid, new.content, 'authority_' || partition_id
        FROM memory_authority_partitions
        WHERE tenant_id = new.tenant_id AND agent_id = new.agent_id
          AND visibility_key = CASE new.visibility
            WHEN 'conversation' THEN 'conversation:' || new.conversation_ref
            WHEN 'principal' THEN 'principal:' || new.principal_id
            ELSE 'agent-shared'
          END;
    END;
  `);
}

export function ensureMemoryRecallIndexes(
  db: Database.Database,
  embeddingDimensions: number,
  vecAvailable: boolean,
): VecTableRebuild[] {
  ensureAuthorityTable(db);
  const rebuilt = vecAvailable ? ensureVectorIndex(db, embeddingDimensions) : [];
  ensureWordIndex(db);
  return rebuilt;
}
