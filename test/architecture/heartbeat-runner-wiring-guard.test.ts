// SPDX-License-Identifier: Apache-2.0
/**
 * Built-but-not-wired SOURCE GUARD for the heartbeat management control plane
 * (`heartbeat.trigger` + `heartbeat.states`). Mirrors
 * `autonomy-revoke-wiring-guard.test.ts` (the same recurring class).
 *
 * Regression this guards: with the per-agent heartbeat runner ACTIVE (boot logs
 * "Per-agent heartbeat runner started" with agentCount>=1), `heartbeat.trigger`
 * returned **"Heartbeat runner not available"** and `heartbeat.states` returned
 * an EMPTY `{agents:[]}` — so the `heartbeat_manage` trigger/states round-trip
 * was UNREACHABLE live even though the runner itself ticks autonomously.
 *
 * Root cause: `createHeartbeatHandlers` (heartbeat-handlers.ts) guards
 * `heartbeat.trigger` on `deps.perAgentRunner` (throws "Heartbeat runner not
 * available" when falsy), and rpc-dispatch.ts threads
 * `perAgentRunner: deps.perAgentRunner` from the ApiDispatchDeps. But the
 * dispatch-deps assembly (`buildRpcDispatchDeps` in daemon.ts) wired
 * `wakeCoalescer: c.wakeCoalescer` from the boot context yet NEVER wired
 * `perAgentRunner: c.perAgentRunner` from the SAME boot context (both are placed
 * on `c` by the post-channels `Object.assign(boot, {…perAgentRunner…wakeCoalescer…})`
 * and both are typed on the boot-context type). So `deps.perAgentRunner` was
 * `undefined` and the trigger/states handlers were dead. The handlers +
 * PerAgentHeartbeatRunner pass their own unit tests
 * (heartbeat-handlers.test.ts); only the LIVE wiring was missing — the program's
 * #1 recurring blocker class (identical shape to the lease.revoke gap).
 *
 * Live incident (fleet-marathon, gpt-5.6-sol): `heartbeat.trigger {agentId}` →
 * "Heartbeat runner not available"; `heartbeat.states` → `{agents:[]}`; daemon.log
 * "Per-agent heartbeat runner started" agentCount=1.
 *
 * This guard pins the live wiring: `buildRpcDispatchDeps` must thread
 * `perAgentRunner` from the boot context alongside `wakeCoalescer`. A refactor
 * that drops the perAgentRunner thread turns this red.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DAEMON_TS = resolve(REPO_ROOT, "packages/daemon/src/daemon.ts");
const RPC_DISPATCH_TS = resolve(REPO_ROOT, "packages/daemon/src/api/rpc-dispatch.ts");
const HEARTBEAT_HANDLERS_TS = resolve(REPO_ROOT, "packages/daemon/src/api/heartbeat-handlers.ts");

/** Strip line + block comments so a token inside a comment cannot satisfy a
 *  wiring assertion (a comment naming perAgentRunner is NOT the wiring). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

describe("heartbeat management (heartbeat.trigger / heartbeat.states) built-but-not-wired source guard", () => {
  it("heartbeat-handlers gates heartbeat.trigger on deps.perAgentRunner (the gate that needs the thread)", () => {
    const code = stripComments(readFileSync(HEARTBEAT_HANDLERS_TS, "utf8"));
    // The trigger handler throws "Heartbeat runner not available" when
    // deps.perAgentRunner is falsy — so the dispatch-deps assembly MUST set it.
    expect(code).toMatch(/!deps\.perAgentRunner/);
    expect(code).toMatch(/Heartbeat runner not available/);
  });

  it("rpc-dispatch threads perAgentRunner from the ApiDispatchDeps into the heartbeat handlers", () => {
    const code = stripComments(readFileSync(RPC_DISPATCH_TS, "utf8"));
    expect(code).toMatch(/perAgentRunner:\s*deps\.perAgentRunner/);
  });

  it("daemon.ts threads perAgentRunner from the boot context into the dispatch deps (alongside wakeCoalescer)", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // wakeCoalescer IS wired from the boot context (both live on `c` via the
    // post-channels Object.assign) — this is the sibling that works.
    expect(code).toMatch(/wakeCoalescer:\s*c\.wakeCoalescer/);
    // perAgentRunner from the SAME boot context MUST be threaded too — else
    // heartbeat.trigger/states are dead live (the fleet-marathon finding).
    expect(code).toMatch(/perAgentRunner:\s*c\.perAgentRunner/);
  });
});
