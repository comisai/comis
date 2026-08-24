// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolveDurableEgressProxyMainPath } from "./terminal-durable-egress-proxy.js";
import { TERMINAL_PROCESS_ENTRIES } from "./terminal-process-entry-registry.js";
import { resolveWorkerMainPath } from "./terminal-worker-launch.js";

describe("terminal process entry registry", () => {
  it("drives the production process entry resolvers", () => {
    expect(resolveWorkerMainPath()).toMatch(
      new RegExp(`${TERMINAL_PROCESS_ENTRIES.worker.outputFile}$`, "u"),
    );
    expect(resolveDurableEgressProxyMainPath()).toMatch(
      new RegExp(`${TERMINAL_PROCESS_ENTRIES.egressProxy.outputFile}$`, "u"),
    );
  });
});
