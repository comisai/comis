// SPDX-License-Identifier: Apache-2.0
import net from "node:net";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { safePath } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import type { ManagedTerminalExecutionAttachment } from "./terminal-managed-binding.js";

export interface AttachmentRelayMaterialization {
  readonly attachments: readonly ManagedTerminalExecutionAttachment[];
  dispose(): Promise<void>;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolveClose) => {
    const closed = tryCatch(() => server.close(() => resolveClose()));
    if (!closed.ok) resolveClose();
  });
}

async function materializeExecutionAttachmentRelaysInDirectory(
  attachments: readonly ManagedTerminalExecutionAttachment[],
  owner: { readonly uid: number; readonly gid: number },
  directoryPath: string,
): Promise<Result<AttachmentRelayMaterialization, Error>> {
  const servers: net.Server[] = [];
  let disposed = false;

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await Promise.all(servers.map(closeServer));
    rmSync(directoryPath, { recursive: true, force: true });
  }

  const ownedDirectory = tryCatch(() => {
    chownSync(directoryPath, owner.uid, owner.gid);
    chmodSync(directoryPath, 0o700);
  });
  if (!ownedDirectory.ok) {
    await dispose();
    return err(ownedDirectory.error);
  }

  const relayed: ManagedTerminalExecutionAttachment[] = [];
  for (const attachment of attachments) {
    const relayPath = tryCatch(() => safePath(directoryPath, attachment.targetName));
    if (!relayPath.ok) {
      await dispose();
      return err(relayPath.error);
    }
    const server = net.createServer((client) => {
      const upstream = net.createConnection(attachment.sourcePath);
      client.once("error", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      upstream.pipe(client);
      client.pipe(upstream);
    });
    servers.push(server);
    const listening = await fromPromise(new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(relayPath.value, resolveListen);
    }));
    if (!listening.ok) {
      await dispose();
      return err(listening.error);
    }
    const ownedSocket = tryCatch(() => {
      chownSync(relayPath.value, owner.uid, owner.gid);
      chmodSync(relayPath.value, 0o600);
    });
    if (!ownedSocket.ok) {
      await dispose();
      return err(ownedSocket.error);
    }
    relayed.push({ ...attachment, sourcePath: relayPath.value });
  }

  return ok(Object.freeze({ attachments: Object.freeze(relayed), dispose }));
}

/** Materialize daemon-owned relays whose endpoints belong to the jail's dedicated uid. */
export async function materializeExecutionAttachmentRelays(
  attachments: readonly ManagedTerminalExecutionAttachment[],
  owner: { readonly uid: number; readonly gid: number },
): Promise<Result<AttachmentRelayMaterialization, Error>> {
  const directory = tryCatch(() => mkdtempSync(resolve("/tmp", "comis-attachments-")));
  return directory.ok
    ? materializeExecutionAttachmentRelaysInDirectory(attachments, owner, directory.value)
    : err(directory.error);
}

export async function materializeExecutionAttachmentRelaysAtPath(
  attachments: readonly ManagedTerminalExecutionAttachment[],
  owner: { readonly uid: number; readonly gid: number },
  directoryPath: string,
): Promise<Result<AttachmentRelayMaterialization, Error>> {
  const created = tryCatch(() => mkdirSync(directoryPath, { mode: 0o700 }));
  return created.ok
    ? materializeExecutionAttachmentRelaysInDirectory(attachments, owner, directoryPath)
    : err(created.error);
}
