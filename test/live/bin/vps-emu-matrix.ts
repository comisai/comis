// SPDX-License-Identifier: Apache-2.0
/**
 * `vps-emu-matrix` — STANDALONE Matrix homeserver-emulator launcher for an
 * EXTERNAL daemon (the VPS production daemon, a test env). The PULL sibling of
 * the Telegram `vps-emu.ts` launcher.
 *
 * Matrix is a PULL channel: the daemon connects OUT to the homeserver and drives
 * the Client-Server `/sync` long-poll — there is no inbound webhook, no request
 * signature to verify, and nothing to post outbound to. So this launcher starts
 * ONLY the fake homeserver (`createMatrixEmulator`) on one loopback port and stays
 * up; it is wired to an already-running daemon by pointing that daemon's Matrix
 * channel at the printed loopback homeserver and enabling the private-homeserver
 * opt-in (both echoed in the `daemonConfig` block below for copy/paste).
 *
 * That opt-in is the loopback SSRF relax the real `validateHomeserverUrl` honors —
 * reaching `127.0.0.1` REQUIRES it, so the guard is EXERCISED (private-range
 * path), never bypassed (cloud-metadata stays blocked). With it set, the daemon's
 * REAL Matrix adapter long-polls this emulator's `/sync` and sends replies to its
 * `/rooms/{id}/send/...` oracle; the emulator's inject/read verbs drive user turns
 * and read bot replies in-process.
 *
 * Writes the wiring to /tmp/comis-matrix-emu.json and prints a one-line startup
 * marker with the same JSON so a driver can parse the port + wiring.
 *
 * TEST-HARNESS — lives under the test tree; consumes only the emulator subtree
 * (node: built-ins at runtime; @comis types are erased).
 */
import { writeFileSync } from "node:fs";
import { createMatrixEmulator } from "../emulators/matrix/matrix-emulator.js";

const emu = createMatrixEmulator();

const { apiRoot, port } = await emu.start();

const info = {
  apiRoot,
  port,
  homeserverUrl: apiRoot,
  pid: process.pid,
  // The exact daemon-side wiring the operator must set (echoed for copy/paste).
  // The daemon connects OUT to this loopback homeserver; the private-range opt-in
  // is what lets the SSRF guard reach 127.0.0.1.
  daemonConfig: {
    "channels.matrix.homeserverUrl": apiRoot,
    "channels.matrix.allowPrivateHomeserver": true,
  },
};
writeFileSync("/tmp/comis-matrix-emu.json", JSON.stringify(info, null, 2));
// eslint-disable-next-line no-console
console.log("MATRIX_EMU_UP " + JSON.stringify(info));

const stop = async (): Promise<void> => {
  try {
    await emu.stop();
  } catch {
    /* best-effort */
  }
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// Keep the event loop alive.
setInterval(() => {}, 1 << 30);
