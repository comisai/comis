// SPDX-License-Identifier: Apache-2.0
/**
 * Free-port helper for test harnesses.
 *
 * Binds a TCP server to 127.0.0.1:0 (kernel-allocated port), reads the
 * OS-assigned port from `server.address()`, closes the server, and
 * resolves with the port number.
 *
 * Security posture: binds to 127.0.0.1 only — never 0.0.0.0 — so the
 * allocated port is unreachable from the LAN (mirrors the listen(0) idiom
 * in test/support/mock-oauth-server.ts).
 *
 * There is an inherent TOCTOU gap between closing the probe server and the
 * caller binding the port. In practice this is negligible in a single-host
 * test environment because the kernel will not immediately re-assign the
 * just-released ephemeral port to another process.
 *
 * @module
 */

import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

/**
 * Allocate one free TCP port on 127.0.0.1 via kernel assignment.
 *
 * @returns The allocated port number (1025–65535 ephemeral range).
 */
export function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
    server.once("error", reject);
  });
}
