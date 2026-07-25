// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "./schema.js";

describe("identity configuration", () => {
  it("parses typed principal mappings for the production resolver", () => {
    const parsed = AppConfigSchema.safeParse({
      identity: {
        principalMappings: [{
          tenantId: "tenant_a",
          agentId: "agent_a",
          assertion: {
            channelType: "telegram",
            channelInstanceId: "account_a",
            platformSubjectId: "subject_a",
          },
          principalId: "principal_a",
        }],
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.identity.principalMappings[0]?.principalId).toBe("principal_a");
  });

  it("defaults identity mappings only at schema parsing", () => {
    expect(AppConfigSchema.parse({}).identity.principalMappings).toEqual([]);
  });
});
