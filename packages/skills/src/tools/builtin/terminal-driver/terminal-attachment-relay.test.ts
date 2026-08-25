// SPDX-License-Identifier: Apache-2.0
import net from "node:net";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materializeExecutionAttachmentRelays } from "./terminal-attachment-relay.js";

describe("terminal execution attachment relay", () => {
  const directories: string[] = [];
  const servers: net.Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("relays through a separately owned endpoint without widening the source socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "attachment-source-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.sock");
    const source = net.createServer((socket) => socket.pipe(socket));
    servers.push(source);
    await new Promise<void>((resolveListen, rejectListen) => {
      source.once("error", rejectListen);
      source.listen(sourcePath, resolveListen);
    });
    chmodSync(sourcePath, 0o600);
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;

    const materialized = await materializeExecutionAttachmentRelays([{
      executionAttachmentId: "execution-attachment_a",
      sourcePath,
      targetName: `attachment-${"a".repeat(32)}.sock`,
      relayIdentity: "ab".repeat(32),
    }], { uid, gid });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const relayPath = materialized.value.attachments[0]!.sourcePath;
    expect(statSync(sourcePath).mode & 0o777).toBe(0o600);
    expect(statSync(relayPath)).toMatchObject({ uid, gid });
    expect(statSync(relayPath).mode & 0o777).toBe(0o600);

    const reply = await new Promise<string>((resolveReply, rejectReply) => {
      const client = net.createConnection(relayPath);
      client.once("error", rejectReply);
      client.once("connect", () => client.write("relay-ok"));
      client.once("data", (chunk) => {
        resolveReply(chunk.toString("utf8"));
        client.destroy();
      });
    });
    expect(reply).toBe("relay-ok");
    await materialized.value.dispose();
  });
});
