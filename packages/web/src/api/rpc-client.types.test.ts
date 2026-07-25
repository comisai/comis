// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from "vitest";
import type { RpcClient } from "./rpc-client.js";

describe("typed web RPC client contract", () => {
  it("unknown method literals fail compilation on the typed client", () => {
    const client = null as unknown as RpcClient;
    if (false) {
      // @ts-expect-error the generated contract map does not contain this method
      void client.call("agent.list", {});
    }
  });

  it("typed call returns the contract result type without caller casts", () => {
    const client = null as unknown as RpcClient;
    if (false) {
      expectTypeOf(client.call("agents.list", {})).resolves.toMatchTypeOf<{
        agents: string[];
      }>();
    }
  });
});
