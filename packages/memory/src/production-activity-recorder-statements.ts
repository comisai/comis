// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";

export interface ActivityRecorderStatements {
  readonly selectMeta: Database.Statement;
  readonly selectRecords: Database.Statement;
  readonly selectRecordAt: Database.Statement;
  readonly selectPage: Database.Statement;
  readonly selectUnsettledAttempts: Database.Statement;
  readonly selectRecoverableAttempts: Database.Statement;
  readonly selectParentState: Database.Statement;
  readonly selectWriterState: Database.Statement;
  readonly insertRecord: Database.Statement;
  readonly updateMeta: Database.Statement;
  readonly insertWriter: Database.Statement;
  readonly renewWriter: Database.Statement;
  readonly closeWriter: Database.Statement;
}

/** Prepare the fixed recorder query set once per isolated SQLite handle. */
export function createActivityRecorderStatements(
  db: Database.Database,
): ActivityRecorderStatements {
  const recordColumns = `sequence, record_id, kind, trace_id, parent_record_id,
    attempt_id, capability_digest, writer_id, occurred_at_ms,
    payload_ciphertext, payload_iv, payload_auth_tag, payload_salt,
    payload_digest, payload_bytes, previous_hash, record_hash,
    state_logical_bytes, state_record_count, state_gap_count,
    proof_ciphertext, proof_iv, proof_auth_tag, proof_salt, logical_bytes`;
  return Object.freeze({
    selectMeta: db.prepare(`
      SELECT stream_id, instance_id, next_sequence, head_hash, logical_bytes,
        record_count, gap_count
      FROM activity_recording_meta WHERE singleton = 1
    `),
    selectRecords: db.prepare(`
      SELECT ${recordColumns} FROM activity_recording_records ORDER BY sequence ASC
    `),
    selectRecordAt: db.prepare(`
      SELECT ${recordColumns} FROM activity_recording_records WHERE sequence = ?
    `),
    selectPage: db.prepare(`
      SELECT ${recordColumns} FROM activity_recording_records
      WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?
    `),
    selectUnsettledAttempts: db.prepare(`
      SELECT ${recordColumns} FROM activity_recording_records AS parent
      WHERE parent.kind = 'delivery_platform_attempt'
        AND parent.writer_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM activity_recording_records AS child
          WHERE child.parent_record_id = parent.record_id
            AND child.kind IN ('delivery_platform_outcome', 'gap')
        )
      ORDER BY parent.sequence ASC
    `),
    selectRecoverableAttempts: db.prepare(`
      SELECT ${recordColumns} FROM activity_recording_records AS parent
      WHERE parent.kind = 'delivery_platform_attempt'
        AND EXISTS (
          SELECT 1 FROM activity_recording_writers AS writer
          WHERE writer.writer_id = parent.writer_id
            AND (writer.closed_at_ms IS NOT NULL OR writer.lease_expires_at_ms <= ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM activity_recording_records AS child
          WHERE child.parent_record_id = parent.record_id
            AND child.kind IN ('delivery_platform_outcome', 'gap')
        )
      ORDER BY parent.sequence ASC
    `),
    selectParentState: db.prepare(`
      SELECT parent.sequence AS sequence, parent.record_id AS record_id,
        parent.record_hash AS record_hash, parent.kind AS kind,
        parent.trace_id AS trace_id, parent.occurred_at_ms AS occurred_at_ms,
        parent.attempt_id AS attempt_id,
        parent.capability_digest AS capability_digest,
        parent.writer_id AS writer_id,
        (SELECT COUNT(*) FROM activity_recording_records AS child
         WHERE child.parent_record_id = parent.record_id
           AND child.kind IN ('delivery_platform_outcome', 'gap')) AS settlement_count
      FROM activity_recording_records AS parent WHERE parent.record_id = ?
    `),
    selectWriterState: db.prepare(`
      SELECT writer_id, instance_id, lease_expires_at_ms, closed_at_ms
      FROM activity_recording_writers WHERE writer_id = ?
    `),
    insertRecord: db.prepare(`
      INSERT INTO activity_recording_records (
        sequence, record_id, kind, trace_id, parent_record_id,
        attempt_id, capability_digest, writer_id, occurred_at_ms,
        payload_ciphertext, payload_iv, payload_auth_tag, payload_salt,
        payload_digest, payload_bytes, previous_hash, record_hash,
        state_logical_bytes, state_record_count, state_gap_count,
        proof_ciphertext, proof_iv, proof_auth_tag, proof_salt, logical_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateMeta: db.prepare(`
      UPDATE activity_recording_meta SET next_sequence = ?, head_hash = ?,
        logical_bytes = ?, record_count = ?, gap_count = ? WHERE singleton = 1
    `),
    insertWriter: db.prepare(`
      INSERT INTO activity_recording_writers
        (writer_id, instance_id, lease_expires_at_ms, closed_at_ms)
      VALUES (?, ?, ?, NULL)
    `),
    renewWriter: db.prepare(`
      UPDATE activity_recording_writers
      SET lease_expires_at_ms = MAX(lease_expires_at_ms, ?)
      WHERE writer_id = ? AND instance_id = ? AND closed_at_ms IS NULL
        AND lease_expires_at_ms > ?
    `),
    closeWriter: db.prepare(`
      UPDATE activity_recording_writers
      SET lease_expires_at_ms = ?, closed_at_ms = ?
      WHERE writer_id = ? AND instance_id = ? AND closed_at_ms IS NULL
    `),
  });
}
