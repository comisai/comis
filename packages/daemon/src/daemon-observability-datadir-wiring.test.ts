// SPDX-License-Identifier: Apache-2.0
/**
 * Composition-root guard for observability readers.
 *
 * Session-index and trajectory writers use the configured active data
 * directory. The RPC readers must receive that same root; forwarding the
 * pre-bootstrap environment fallback instead makes `obs.explain <traceId>`
 * report `session_not_found` while `obs.system.health` still sees the same
 * session through SQLite.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const daemonSource = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

describe("observability data-directory composition wiring", () => {
  it("forwards the configured active data directory to RPC observability readers", () => {
    const start = daemonSource.indexOf("function buildRpcDispatchDeps(");
    const end = daemonSource.indexOf("\n/**\n * Replay restart continuations", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const dispatchWiring = daemonSource.slice(start, end);
    expect(dispatchWiring).toContain(
      "dataDir: c.container.config.dataDir || c.dataDir",
    );
    expect(dispatchWiring).not.toContain("dataDir: c.dataDir,");
  });
});
