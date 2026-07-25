// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createPrincipalResolver } from "./principal-resolver.js";

describe("principal resolver authority mapping", () => {
  it("unmapped platform subject namespaces by channel type and configured instance", () => {
    const created = createPrincipalResolver([]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const telegramA = created.value.resolve("tenant_a", "agent_a", {
      channelType: "telegram",
      channelInstanceId: "account_a",
      platformSubjectId: "subject_1",
    });
    const telegramB = created.value.resolve("tenant_a", "agent_a", {
      channelType: "telegram",
      channelInstanceId: "account_b",
      platformSubjectId: "subject_1",
    });
    const discordA = created.value.resolve("tenant_a", "agent_a", {
      channelType: "discord",
      channelInstanceId: "account_a",
      platformSubjectId: "subject_1",
    });
    expect(telegramA.ok && telegramB.ok && discordA.ok).toBe(true);
    if (!telegramA.ok || !telegramB.ok || !discordA.ok) return;
    expect(new Set([
      telegramA.value.principalId,
      telegramB.value.principalId,
      discordA.value.principalId,
    ]).size).toBe(3);
  });

  it("cross-account identity joins only through an explicit typed operator mapping", () => {
    const created = createPrincipalResolver([
      {
        tenantId: "tenant_a",
        agentId: "agent_a",
        assertion: { channelType: "telegram", channelInstanceId: "account_a", platformSubjectId: "subject_1" },
        principalId: "person_a",
      },
      {
        tenantId: "tenant_a",
        agentId: "agent_a",
        assertion: { channelType: "discord", channelInstanceId: "account_b", platformSubjectId: "subject_9" },
        principalId: "person_a",
      },
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = created.value.resolve("tenant_a", "agent_a", {
      channelType: "telegram", channelInstanceId: "account_a", platformSubjectId: "subject_1",
    });
    const second = created.value.resolve("tenant_a", "agent_a", {
      channelType: "discord", channelInstanceId: "account_b", platformSubjectId: "subject_9",
    });
    expect(first).toEqual({ ok: true, value: { principalId: "person_a" } });
    expect(second).toEqual({ ok: true, value: { principalId: "person_a" } });
  });
});
