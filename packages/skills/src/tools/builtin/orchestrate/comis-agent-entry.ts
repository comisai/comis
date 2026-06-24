#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * `comis-agent` entrypoint — the `#!/usr/bin/env node` binary bound read-only
 * into the orchestrate jail (Plan 06 sha256-pins + binds this dist file beside
 * the daemon `node` binary). It wires the REAL {@link callCapSocket} (the lease
 * cap socket wire) into {@link runComisAgent} and exits with the returned code.
 *
 * This file holds NO logic beyond the wiring — the parse/dispatch lives in
 * `comis-agent-cli.ts` (so it is unit-testable over a fake callCapSocket). The
 * only egress is {@link callCapSocket}; there is deliberately no WebSocket /
 * gateway client (CLI-04) and no argv-parsing dependency (§2.3).
 *
 * @module
 */
import { callCapSocket } from "./orchestrate-sdk-runtime.js";
import { runComisAgent } from "./comis-agent-cli.js";

void runComisAgent(process.argv.slice(2), {
  callCapSocket,
  stdout: (s: string) => void process.stdout.write(s),
  stderr: (s: string) => void process.stderr.write(s),
}).then((code) => {
  process.exit(code);
});
