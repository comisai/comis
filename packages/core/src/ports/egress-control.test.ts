// SPDX-License-Identifier: Apache-2.0
/**
 * Port-surface test for {@link EgressControlPort} — the type-only
 * no-secret host-allowlist egress filter, DISTINCT from the credential broker.
 * This file proves the interface SHAPE (a value fixture must satisfy
 * the contract) and that the type resolves on the public `@comis/core` surface;
 * the runtime behaviour (the allowlist proxy + the in-jail relay) lives in
 * @comis/daemon / @comis/skills and is tested there.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

// The port must resolve from BOTH the internal path AND the public surface.
import type { EgressControlPort, EgressMaterialization } from "./egress-control.js";
import type {
  EgressControlPort as EgressControlPortPublic,
  EgressMaterialization as EgressMaterializationPublic,
} from "@comis/core";

describe("EgressControlPort — type-only no-secret host-allowlist filter", () => {
  it("a value fixture satisfies the EgressMaterialization + EgressControlPort contract", async () => {
    // A minimal in-memory fixture proving the interface is implementable: a
    // materialize(hosts) -> { socketPath, dispose() } shape. If the interface
    // ever drifts (e.g. materialize loses its hosts arg, or dispose stops
    // returning a Promise), this fixture stops type-checking and the build fails.
    let disposed = false;
    const fixture: EgressControlPort = {
      async materialize(hosts: string[]): Promise<EgressMaterialization> {
        return {
          socketPath: `/tmp/egress-${hosts.length}.sock`,
          async dispose(): Promise<void> {
            disposed = true;
          },
        };
      },
    };

    const mat = await fixture.materialize(["api.example.com"]);
    expect(mat.socketPath).toContain(".sock");
    expect(typeof mat.dispose).toBe("function");
    await mat.dispose();
    expect(disposed).toBe(true);
  });

  it("the port type is re-exported on the public @comis/core surface", () => {
    // Compile-time proof: the public-surface aliases are assignable from the
    // internal-path types (they are the SAME type, re-exported via
    // exports/ports.ts). A runtime no-op — the assertion is that this file
    // type-checks at all.
    const _port: EgressControlPortPublic = {
      async materialize(): Promise<EgressMaterializationPublic> {
        return { socketPath: "/tmp/x.sock", async dispose() {} };
      },
    };
    expect(typeof _port.materialize).toBe("function");
  });
});
