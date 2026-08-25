// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from "vitest";
import type { ExecutionAttachmentPort } from "./execution-attachment.js";

describe("ExecutionAttachmentPort durable authority boundary", () => {
  it("exposes only scoped create read revoke reconcile and recovery operations", () => {
    expectTypeOf<keyof ExecutionAttachmentPort>().toEqualTypeOf<
      | "create"
      | "get"
      | "listActiveForRun"
      | "revoke"
      | "reconcile"
      | "listRecoverable"
    >();
  });
});
