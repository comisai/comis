// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createDeterministicLocalization, renderLocalized } from "./deterministic-localization.js";

describe("deterministic localization", () => {
  it("renders approval denial help and error replies through one port", () => {
    const localization = createDeterministicLocalization();

    expect(localization.render({
      key: "approval.resolved_one",
      locale: "en",
      values: { outcome: "denied", action: "shell", id: "abc123" },
    })).toEqual({ ok: true, value: "Denied: shell (abc123)" });
    expect(localization.render({ key: "help.commands", locale: "en" })).toMatchObject({
      ok: true,
      value: expect.stringContaining("/approve"),
    });
    expect(localization.render({ key: "error.callback_invalid", locale: "en" })).toEqual({
      ok: true,
      value: "This callback is no longer valid (it may have already been resolved or expired).",
    });
  });

  it("uses the deterministic base catalog for an open canonical locale", () => {
    const localization = createDeterministicLocalization();
    expect(localization.render({ key: "approval.none_pending", locale: "sr-Latn-RS" }))
      .toEqual({ ok: true, value: "No pending approvals." });
  });

  it("uses the resolved agent locale pack instead of the channel advisory locale", () => {
    const localization = createDeterministicLocalization({
      getLocaleConfig: (agentId) => agentId === "agent_he"
        ? {
            language: "he-IL",
            localePacks: {
              he: {
                "error.callback_invalid": "הפעולה הזו כבר אינה זמינה.",
                "approval.resolved_one.approved": "אושר: {action} ({id})",
              },
            },
          }
        : undefined,
    });

    expect(localization.render({
      agentId: "agent_he",
      key: "error.callback_invalid",
      locale: "en-US",
    })).toEqual({ ok: true, value: "הפעולה הזו כבר אינה זמינה." });
    expect(localization.render({
      agentId: "agent_he",
      key: "approval.resolved_one",
      locale: "en-US",
      values: { outcome: "approved", action: "shell", id: "abc123" },
    })).toEqual({ ok: true, value: "אושר: shell (abc123)" });
  });

  it("fails closed when required template values are missing", () => {
    const localization = createDeterministicLocalization();
    expect(localization.render({ key: "approval.resolved_one", locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "missing_value" } });
  });

  it("renders every approval response with validated interpolation values", () => {
    const localization = createDeterministicLocalization();

    expect(localization.render({ key: "approval.none_pending_resolve", locale: "en" }))
      .toEqual({ ok: true, value: "No pending approvals to resolve." });
    expect(localization.render({
      key: "approval.multiple",
      locale: "en",
      values: { command: "/approve", choices: "one\ntwo" },
    })).toEqual({
      ok: true,
      value: "Multiple pending approvals. Specify an ID or use \"/approve all\":\none\ntwo",
    });
    expect(localization.render({
      key: "approval.resolved_many",
      locale: "en",
      values: { outcome: "approved", count: 2 },
    })).toEqual({ ok: true, value: "Approved 2 pending approval(s)." });
    expect(localization.render({
      key: "approval.not_found",
      locale: "en",
      values: { id: "approval_a" },
    })).toMatchObject({ ok: true, value: expect.stringContaining("approval_a") });
    expect(localization.render({ key: "error.report_unavailable", locale: "en" }))
      .toEqual({ ok: true, value: "This report is no longer available." });
    expect(localization.render({ key: "session.reset", locale: "en" }))
      .toEqual({ ok: true, value: "Session reset." });
  });

  it("renders managed attention acknowledgement and ambiguity prompts", () => {
    const localization = createDeterministicLocalization();

    expect(localization.render({
      key: "attention.response_bound",
      locale: "en",
      values: { id: "attention_a" },
    })).toEqual({ ok: true, value: "Response recorded for attention request attention_a." });
    expect(localization.render({
      key: "attention.multiple",
      locale: "en",
      values: { choices: "- attention_a\n- attention_b" },
    })).toMatchObject({ ok: true, value: expect.stringContaining("/attention <ID> <response>") });
  });

  it("rejects unsupported approval outcomes and renders port errors safely", () => {
    const localization = createDeterministicLocalization();
    const invalid = localization.render({
      key: "approval.resolved_many",
      locale: "en",
      values: { outcome: "maybe", count: 1 },
    });

    expect(invalid).toMatchObject({ ok: false, error: { kind: "invalid_value" } });
    expect(renderLocalized(localization, {
      key: "approval.not_found",
      locale: "en",
    })).toBe("The requested response could not be rendered.");
  });

  it.each([
    ["invalid single outcome", "approval.resolved_one", { outcome: "maybe", action: "shell", id: "id_a" }, "invalid_value"],
    ["missing single action", "approval.resolved_one", { outcome: "approved", id: "id_a" }, "missing_value"],
    ["missing single id", "approval.resolved_one", { outcome: "approved", action: "shell" }, "missing_value"],
    ["missing multiple command", "approval.multiple", { choices: "one" }, "missing_value"],
    ["missing multiple choices", "approval.multiple", { command: "/approve" }, "missing_value"],
    ["missing many outcome", "approval.resolved_many", { count: 2 }, "missing_value"],
    ["missing many count", "approval.resolved_many", { outcome: "denied" }, "missing_value"],
  ] as const)("rejects %s interpolation", (_label, key, values, expectedKind) => {
    const localization = createDeterministicLocalization();

    expect(localization.render({ key, locale: "en", values }))
      .toMatchObject({ ok: false, error: { kind: expectedKind } });
  });
});
