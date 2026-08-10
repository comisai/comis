// SPDX-License-Identifier: Apache-2.0
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveChatApprovalAuthority,
  resolveChatSessionArtifacts,
} from "./session-artifact-ref.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("live Telegram approval authority", () => {
  it("uses the current durable session instead of a stale delivery mirror", () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "comis-approval-authority-"));
    temporaryDirectories.push(dataDir);
    const sessionDirectory = resolve(dataDir, "workspace", "sessions", "default", "telegram");
    mkdirSync(sessionDirectory, { recursive: true });

    const sessionKey =
      "default:agent:default:platform_current:telegram:peer:platform_current";
    const sessionFile = resolve(
      sessionDirectory,
      "platform_current~peer~platform_current.jsonl",
    );
    const trajectoryFile = `${sessionFile}.trajectory.jsonl`;
    writeFileSync(sessionFile, "", { mode: 0o600 });
    writeFileSync(trajectoryFile, "{}\n", { mode: 0o600 });
    writeFileSync(
      `${sessionFile}.trajectory-path.json`,
      `${JSON.stringify({
        traceSchema: "comis-trajectory-pointer",
        schemaVersion: 1,
        sessionId: sessionKey,
        runtimeFile: trajectoryFile,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      sessionFile.replace(/\.jsonl$/, "~ledger~inbound.jsonl"),
      `${JSON.stringify({
        customType: "comis.inbound-message-provenance",
        data: {
          messages: [{
            channelId: "678314278",
            channelType: "telegram",
          }],
        },
      })}\n`,
      { mode: 0o600 },
    );

    const db = new Database(resolve(dataDir, "memory.db"));
    db.exec(`
      CREATE TABLE lcd_messages (
        conversation_ref TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE delivery_mirror (
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_ref TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO delivery_mirror VALUES (?, ?, ?, ?, ?, ?)",
    ).run("default", "default", "cv_stale", "telegram", "678314278", 2);
    db.prepare(
      "INSERT INTO lcd_messages VALUES (?, ?, ?, ?, ?, ?)",
    ).run("cv_current", "default", "default", sessionKey, 7, 1);

    expect(resolveChatApprovalAuthority(dataDir, "678314278", db)).toEqual({
      tenant_id: "default",
      agent_id: "default",
      conversation_ref: "cv_current",
    });
    db.close();
  });
});

describe("live Telegram forum artifact resolution", () => {
  it("selects the requested forum topic instead of the newest sibling topic", () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "comis-forum-artifacts-"));
    temporaryDirectories.push(dataDir);
    const sessionDirectory = resolve(dataDir, "workspace", "sessions", "default", "telegram");
    mkdirSync(sessionDirectory, { recursive: true });

    const writeTopic = (threadId: number, mtimeMs: number) => {
      const sessionFile = resolve(sessionDirectory, `conversation~thread~${threadId}.jsonl`);
      const trajectoryFile = `${sessionFile}.trajectory.jsonl`;
      writeFileSync(sessionFile, "", { mode: 0o600 });
      writeFileSync(trajectoryFile, "{}\n", { mode: 0o600 });
      writeFileSync(
        `${sessionFile}.trajectory-path.json`,
        `${JSON.stringify({
          traceSchema: "comis-trajectory-pointer",
          schemaVersion: 1,
          sessionId: `default:agent:default:conversation:telegram:bot:-1001234567890:thread:${threadId}`,
          runtimeFile: trajectoryFile,
        })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        sessionFile.replace(/\.jsonl$/, "~ledger~inbound.jsonl"),
        `${JSON.stringify({
          customType: "comis.inbound-message-provenance",
          data: {
            messages: [{
              channelId: "-1001234567890",
              channelType: "telegram",
            }],
          },
        })}\n`,
        { mode: 0o600 },
      );
      const modifiedAt = new Date(mtimeMs);
      utimesSync(trajectoryFile, modifiedAt, modifiedAt);
      return { sessionFile, trajectoryFile };
    };

    const topic7 = writeTopic(7, 1_000);
    writeTopic(8, 2_000);

    expect(resolveChatSessionArtifacts(dataDir, "-1001234567890", 7)).toEqual(topic7);
  });
});
