// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createCompletionRecovery } from "./completion-recovery.js";

describe("createCompletionRecovery", () => {
  it("exposes the complete durable recovery lifecycle", () => {
    const recovery = createCompletionRecovery({} as never);

    expect(Object.keys(recovery).sort()).toEqual([
      "finishCleanup",
      "reconcileDeliveryClaim",
      "recoverClaimedTask",
    ]);
  });
});
