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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildEgressRelayLaunch } from "./terminal-egress-relay.js";

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
