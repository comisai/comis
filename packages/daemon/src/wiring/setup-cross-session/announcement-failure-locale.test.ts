// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createAnnouncementFailureNoticeRenderer } from "./announcement-failure-locale.js";

describe("announcement failure locale renderer", () => {
  it("renders the failed terminal notice from the selected agent locale pack", () => {
    const render = createAnnouncementFailureNoticeRenderer({
      default: {
        language: "he",
        localePacks: {
          he: {
            background_task_failed_notice:
              "⚠️ משימת הרקע נכשלה ולכן התוצאה עלולה להיות חלקית.",
          },
        },
      } as never,
    });

    expect(render("default", "und-Hebr"))
      .toBe("⚠️ משימת הרקע נכשלה ולכן התוצאה עלולה להיות חלקית.");
  });
});
