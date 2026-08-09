// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from "vitest";
import type { WorkspaceLeasePort } from "./workspace-lease.js";

describe("WorkspaceLeasePort durable authority boundary", () => {
  it("exposes only create, scoped read, release, reconcile, and recovery scan", () => {
    expectTypeOf<keyof WorkspaceLeasePort>().toEqualTypeOf<
      "create" | "get" | "release" | "reconcile" | "listRecoverable"
    >();
  });
});
