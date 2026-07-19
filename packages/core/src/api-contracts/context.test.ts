// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ContextTreeContract } from "./context.js";

describe("context control-plane authority", () => {
  it("context tree requires an opaque conversation reference", () => {
    const reference = `cv_${"a".repeat(43)}`;
    expect(ContextTreeContract.request.safeParse({ conversation_ref: reference }).success).toBe(true);
    expect(ContextTreeContract.request.safeParse({ conversation_id: "formatted:session:key" }).success).toBe(false);
  });
});
