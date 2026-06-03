// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the in-jail relay-as-init launcher builder
 * (`buildEgressRelayLaunch`, worker-side, PORT-typed, SEC-07).
 *
 * `buildEgressRelayLaunch` is a PURE constructor: given the host socket path +
 * the in-jail relay port, it returns the pieces the worker (122-06) needs to
 * spawn the driven child UNDER the relay — the relay-as-init wrapper argv (bring
 * `lo` up as userns-root -> TCP->unix bridge on 127.0.0.1:<port> -> drop to the
 * net-new uid -> exec the child) AND the `HTTPS_PROXY`/`HTTP_PROXY` env addition
 * pointing the child's TCP-proxy client at the in-jail relay. It runs NOTHING (no
 * netns, no spawn) — so it is fully macOS-testable. The LIVE bridge + uid-drop is
 * VPS-only (122-07).
 *
 * It imports `EgressControlPort` as a TYPE from @comis/core and NEVER value-imports
 * @comis/infra (the architecture test from Task 1 names this file; this file adds a
 * focused source grep as a second, local guard).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildEgressRelayLaunch,
  RELAY_INIT_SCRIPT_URL,
} from "./terminal-egress-relay.js";

describe("buildEgressRelayLaunch — in-jail relay-as-init launcher builder (SEC-07)", () => {
  it("returns the HTTPS_PROXY/HTTP_PROXY env pointing the child at the in-jail relay port", () => {
    const out = buildEgressRelayLaunch({ socketPath: "/tmp/e.sock", relayPort: 18080 });
    expect(out.proxyEnv.HTTPS_PROXY).toBe("http://127.0.0.1:18080");
    expect(out.proxyEnv.HTTP_PROXY).toBe("http://127.0.0.1:18080");
  });

  it("wires the supplied relayPort into the env (a different port flows through)", () => {
    const out = buildEgressRelayLaunch({ socketPath: "/tmp/e.sock", relayPort: 19999 });
    expect(out.proxyEnv.HTTPS_PROXY).toContain("19999");
    expect(out.proxyEnv.HTTP_PROXY).toContain("19999");
  });

  it("constructs a relay-as-init wrapper argv that references the bind-mounted socket + the relay port", () => {
    const out = buildEgressRelayLaunch({ socketPath: "/tmp/sess.sock", relayPort: 18080 });
    expect(Array.isArray(out.relayArgv)).toBe(true);
    expect(out.relayArgv.length).toBeGreaterThan(0);
    // The wrapper must carry the two coordinates the in-jail relay bridges
    // between: the loopback port (127.0.0.1:<port>) and the unix socket.
    const joined = out.relayArgv.join(" ");
    expect(joined).toContain("/tmp/sess.sock");
    expect(joined).toContain("18080");
  });

  it("relayArgv invokes the RUNNABLE relay-init script via process.execPath, ending with `--` before the child", () => {
    // 122-fix: the relayArgv is no longer a bare sentinel name — it is the real
    // in-jail launch: `node <relay-init script> --socket <sock> --port <port> --`,
    // so the worker can append `bin ...childArgv` after the `--` and the kernel
    // brings up the relay-as-init for real (the 118 G-3 transport). This was the
    // SEC-07 production gap: the launcher pointed at a script that did not exist.
    const out = buildEgressRelayLaunch({ socketPath: "/tmp/sess.sock", relayPort: 18080 });
    // arg0 is the Node runtime (the script is run as a subprocess).
    expect(out.relayArgv[0]).toBe(process.execPath);
    // arg1 is the relay-init script path (resolved from the module URL).
    expect(out.relayArgv[1]).toBe(fileURLToPath(RELAY_INIT_SCRIPT_URL));
    // The flags carry the bridge coordinates and terminate with `--`.
    expect(out.relayArgv).toContain("--socket");
    expect(out.relayArgv).toContain("/tmp/sess.sock");
    expect(out.relayArgv).toContain("--port");
    expect(out.relayArgv).toContain("18080");
    expect(out.relayArgv[out.relayArgv.length - 1]).toBe("--");
  });

  it("points at a relay-init script that actually exists on disk (the launcher target is real)", () => {
    // The exported script URL must resolve to a real file — the bug was a launcher
    // that referenced a not-yet-built binary, leaving listed-hosts egress dead.
    expect(existsSync(fileURLToPath(RELAY_INIT_SCRIPT_URL))).toBe(true);
  });

  it("the socketPath round-trips so the caller can bind-mount it (buildScopeArgs relaySocketPath)", () => {
    const out = buildEgressRelayLaunch({ socketPath: "/tmp/round.sock", relayPort: 18080 });
    expect(out.socketPath).toBe("/tmp/round.sock");
  });

  it("is PORT-typed + infra-free: zero @comis/infra value imports in the module source", () => {
    // A focused, local source grep (the architecture suite has the canonical
    // named guard). The relay launcher must depend ONLY on the EgressControlPort
    // TYPE from @comis/core + node builtins — never @comis/infra.
    const src = readFileSync(
      fileURLToPath(new URL("./terminal-egress-relay.ts", import.meta.url)),
      "utf8",
    );
    // No value-import of @comis/infra (a type-only import would be `import type`).
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+["']@comis\/infra["']/m);
    // It DOES reference the EgressControlPort type from core.
    expect(src).toMatch(/EgressControlPort/);
  });
});
