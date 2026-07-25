// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the bounded fs.readSync boundary is translated to Result.err by tryCatch.
/** Bounded reverse JSONL reader used by the offline channel-message extractor. */

import * as fs from "node:fs";
import { tryCatch, type Result } from "@comis/shared";

/** Latest ordinary records retained from one file. */
export const MAX_SESSION_MESSAGE_RECORDS = 5_000;

/** Maximum provenance chunks that may precede the oldest ordinary record. */
const MAX_PROVENANCE_PREDECESSOR_RECORDS = 32;

/** Reverse-scan read block. */
const RECORD_SCAN_CHUNK_BYTES = 64 * 1024;

/** Per-record allocation ceiling. */
const MAX_RECORD_BYTES = 1024 * 1024;

/** Per-file disk-read ceiling. */
export const MAX_SESSION_MESSAGE_FILE_SCAN_BYTES = 16 * 1024 * 1024;

/** Aggregate disk-read ceiling for one extraction. */
export const MAX_SESSION_MESSAGE_TOTAL_SCAN_BYTES = 256 * 1024 * 1024;

export type BoundedLogicalRecord =
  | { kind: "line"; line: string; contextOnly: boolean }
  | { kind: "oversized"; contextOnly: boolean };

export interface LatestLogicalRecords {
  /** Retained nonblank records in file order. */
  records: BoundedLogicalRecord[];
  /** True when an older nonblank record existed beyond the ordinary record cap. */
  capped: boolean;
  /** Bytes read from the file during this scan. */
  bytesScanned: number;
  /** True when older bytes remained outside the supplied scan budget. */
  byteCapped: boolean;
  /** True when the oldest ordinary record has an unknown older prefix. */
  prefixUncertain: boolean;
}

/** Open without following the final path component or blocking on a swapped FIFO. */
function resolveSessionReadFlags(): number {
  return fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);
}

/** Whether a byte buffer contains a non-whitespace byte other than newline. */
function hasNonblankByte(value: Buffer): boolean {
  for (const byte of value) {
    if (
      byte !== 0x09 &&
      byte !== 0x0b &&
      byte !== 0x0c &&
      byte !== 0x0d &&
      byte !== 0x20
    ) return true;
  }
  return false;
}

/**
 * Read the latest bounded logical JSONL records plus a bounded predecessor
 * runway. The runway can complete one provenance occurrence crossing the
 * record boundary without broadening the ordinary 5,000-record window.
 */
export function readLatestLogicalRecords(
  filePath: string,
  byteBudget: number,
): Result<LatestLogicalRecords, Error> {
  return tryCatch(() => {
    const fd = fs.openSync(filePath, resolveSessionReadFlags());
    try {
      const fileStat = fs.fstatSync(fd);
      if (!fileStat.isFile()) {
        throw new Error("Session-message source is not a regular file");
      }
      let position = fileStat.size;
      let suffix = Buffer.alloc(0);
      let oversizedCurrent = false;
      let oversizedHasNonblank = false;
      const newestFirst: BoundedLogicalRecord[] = [];
      let ordinaryRecords = 0;
      let predecessorRecords = 0;
      let capped = false;
      let runwayFull = false;
      let bytesScanned = 0;

      const retain = (
        line: Buffer,
        oversized: boolean,
        knownNonblank: boolean,
      ): void => {
        const decoded = line.toString("utf8");
        if (oversized ? !knownNonblank : decoded.trim() === "") return;

        let contextOnly = false;
        if (ordinaryRecords < MAX_SESSION_MESSAGE_RECORDS) {
          ordinaryRecords++;
        } else {
          capped = true;
          if (predecessorRecords >= MAX_PROVENANCE_PREDECESSOR_RECORDS) {
            runwayFull = true;
            return;
          }
          predecessorRecords++;
          contextOnly = true;
        }
        newestFirst.push(
          oversized
            ? { kind: "oversized", contextOnly }
            : { kind: "line", line: decoded, contextOnly },
        );
      };

      while (position > 0 && !runwayFull && bytesScanned < byteBudget) {
        const requested = Math.min(
          RECORD_SCAN_CHUNK_BYTES,
          position,
          byteBudget - bytesScanned,
        );
        position -= requested;
        const allocation = Buffer.allocUnsafe(requested);
        const bytesRead = fs.readSync(fd, allocation, 0, requested, position);
        if (bytesRead !== requested) {
          throw new Error("Session file stopped yielding bytes before the scan boundary");
        }
        bytesScanned += bytesRead;
        const chunk = allocation.subarray(0, bytesRead);
        let lineEnd = chunk.length;

        for (let index = chunk.length - 1; index >= 0; index -= 1) {
          if (chunk[index] !== 0x0a) continue;
          const chunkPart = chunk.subarray(index + 1, lineEnd);
          const knownNonblank = oversizedHasNonblank ||
            hasNonblankByte(chunkPart) ||
            hasNonblankByte(suffix);
          const lineIsOversized = oversizedCurrent ||
            chunkPart.length + suffix.length > MAX_RECORD_BYTES;
          const line = lineIsOversized
            ? Buffer.alloc(0)
            : suffix.length === 0
              ? chunkPart
              : Buffer.concat([chunkPart, suffix]);
          retain(line, lineIsOversized, knownNonblank);
          if (runwayFull) break;
          suffix = Buffer.alloc(0);
          oversizedCurrent = false;
          oversizedHasNonblank = false;
          lineEnd = index;
        }

        if (!runwayFull) {
          const prefix = chunk.subarray(0, lineEnd);
          if (oversizedCurrent) {
            oversizedHasNonblank ||= hasNonblankByte(prefix);
          } else if (prefix.length + suffix.length > MAX_RECORD_BYTES) {
            oversizedCurrent = true;
            oversizedHasNonblank = hasNonblankByte(prefix) || hasNonblankByte(suffix);
            suffix = Buffer.alloc(0);
          } else {
            suffix = suffix.length === 0
              ? Buffer.from(prefix)
              : Buffer.concat([prefix, suffix]);
          }
        }
      }

      if (!runwayFull && position === 0 && (suffix.length > 0 || oversizedCurrent)) {
        retain(suffix, oversizedCurrent, oversizedHasNonblank || hasNonblankByte(suffix));
      }
      const byteCapped = !runwayFull && position > 0;
      if (byteCapped && oversizedCurrent) {
        retain(Buffer.alloc(0), true, oversizedHasNonblank || hasNonblankByte(suffix));
      }
      return {
        records: newestFirst.reverse(),
        capped,
        bytesScanned,
        byteCapped,
        prefixUncertain: capped || byteCapped,
      };
    } finally {
      fs.closeSync(fd);
    }
  });
}
