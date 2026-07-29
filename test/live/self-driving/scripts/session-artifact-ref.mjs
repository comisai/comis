// Resolve a physical channel chat to its current durable session artifacts.
// Privacy-principal routing intentionally removes the physical chat id from the
// directory name, so resolution uses structured inbound provenance rather than
// guessing a legacy path.
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function provenanceMatches(file, chatId) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (stat.size > MAX_FILE_BYTES) return false;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes("comis.inbound-message-provenance") || !line.includes(chatId)) continue;
    try {
      const record = JSON.parse(line);
      if (
        record.customType === "comis.inbound-message-provenance"
        && Array.isArray(record.data?.messages)
        && record.data.messages.some(
          (message) =>
            String(message?.channelId) === chatId
            && message?.channelType === "telegram",
        )
      ) return true;
    } catch {
      // Malformed lines are not identity evidence.
    }
  }
  return false;
}

function trajectoryForSession(sessionFile) {
  const pointerFile = `${sessionFile}.trajectory-path.json`;
  try {
    const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
    if (
      pointer.traceSchema === "comis-trajectory-pointer"
      && pointer.schemaVersion === 1
      && typeof pointer.runtimeFile === "string"
      && existsSync(pointer.runtimeFile)
    ) return pointer.runtimeFile;
  } catch {
    // Fall through to the co-located writer convention.
  }
  const colocated = `${sessionFile}.trajectory.jsonl`;
  return existsSync(colocated) ? colocated : undefined;
}

export function resolveChatSessionArtifacts(dataDir, chatId) {
  const root = join(dataDir, "workspace", "sessions");
  const stack = [root];
  const candidates = new Map();
  let seen = 0;
  while (stack.length > 0 && seen < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= MAX_FILES) break;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
        continue;
      }
      seen += 1;
      if (!entry.name.endsWith(".jsonl") || entry.name.endsWith(".trajectory.jsonl")) continue;
      if (!provenanceMatches(file, chatId)) continue;
      const sessionFile = file.endsWith("~ledger~inbound.jsonl")
        ? file.replace(/~ledger~inbound\.jsonl$/, ".jsonl")
        : file;
      const trajectoryFile = trajectoryForSession(sessionFile);
      if (trajectoryFile === undefined) continue;
      candidates.set(sessionFile, {
        sessionFile,
        trajectoryFile,
        mtimeMs: statSync(trajectoryFile).mtimeMs,
      });
    }
  }
  const newest = [...candidates.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return newest === undefined
    ? undefined
    : { sessionFile: newest.sessionFile, trajectoryFile: newest.trajectoryFile };
}
