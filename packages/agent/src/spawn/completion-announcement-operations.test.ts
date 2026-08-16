// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createCompletionAnnouncementOperationPlan } from "./completion-announcement-operations.js";

describe("completion announcement operation planning", () => {
  it("separates an unbounded sanitized summary from attachment captions", () => {
    const text = `Report: /workspace/reports/monthly.csv ${"x".repeat(1_100)}`;

    const plan = createCompletionAnnouncementOperationPlan(text, [
      { sourceAgentId: "worker-a", path: "/workspace/reports/monthly.csv" },
      { sourceAgentId: "worker-a", path: "C:\\workspace\\reports\\annual.csv" },
    ]);

    expect(plan).toEqual({
      pathReplacements: 1,
      operations: [
        {
          text: `Report: monthly.csv ${"x".repeat(1_100)}`,
          partId: "summary",
        },
        {
          text: "",
          partId: "attachment:0",
          attachmentIndex: 0,
          attachment: {
            sourceAgentId: "worker-a",
            path: "/workspace/reports/monthly.csv",
          },
        },
        {
          text: "",
          partId: "attachment:1",
          attachmentIndex: 1,
          attachment: {
            sourceAgentId: "worker-a",
            path: "C:\\workspace\\reports\\annual.csv",
          },
        },
      ],
    });
  });
});
