// SPDX-License-Identifier: Apache-2.0
import { err, ok } from "@comis/shared";
import { describe, expect, it } from "vitest";

import { parseProductionProfile } from "./production-profile.js";
import {
  MESSAGES_ATTESTATION_BEGIN,
  MESSAGES_ATTESTATION_END,
  buildProductionMessagesPlan,
  executeProductionMessagesAttestation,
  parseProductionMessagesAttestation,
} from "./production-messages.js";

const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);
const HISTORY_DIGEST = "c".repeat(64);
const PROFILE_TEXT = `
SOURCE_HOST=source-box
TARGET_HOST=test-box
SOURCE_SSH_PORT=2222
TARGET_SSH_PORT=2202
SOURCE_ROLE=production
TARGET_ROLE=test
SOURCE_COMIS_USER=comis
TARGET_COMIS_USER=comis
SOURCE_DATA=/srv/source/.comis
TARGET_DATA=/srv/target/.comis
SOURCE_SERVICE=comis
TARGET_SERVICE=comis
SOURCE_MACHINE_ID_SHA256=${SOURCE_MACHINE}
TARGET_MACHINE_ID_SHA256=${TARGET_MACHINE}
`;

function profile() {
  const parsed = parseProductionProfile(PROFILE_TEXT);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("fixture profile invalid");
  return parsed.value;
}

function facts(count = 36, digest = HISTORY_DIGEST): string {
  return [
    MESSAGES_ATTESTATION_BEGIN,
    JSON.stringify({
      schema: "comis-offline-messages-attestation",
      schemaVersion: 1,
      channel: "telegram",
      limit: 10_000,
      count,
      bytes: 22_075,
      digestSha256: digest,
      truncated: count === 10_000,
    }),
    MESSAGES_ATTESTATION_END,
    "",
  ].join("\n");
}

describe("production offline channel message attestation", () => {
  it("builds the mandated offline command while keeping raw prompts remote", () => {
    const plan = buildProductionMessagesPlan({
      host: "source-box",
      port: 2222,
      expectedMachineIdSha256: SOURCE_MACHINE,
      role: "production",
      serviceUser: "comis",
      service: "comis",
      dataDir: "/srv/source/.comis",
      channel: "telegram",
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value).toMatchObject({
      host: "source-box",
      port: 2222,
      args: [
        "sudo",
        "bash",
        "-s",
        "--",
        SOURCE_MACHINE,
        "production",
        "comis",
        "comis",
        "/srv/source/.comis",
        "telegram",
      ],
    });
    expect(plan.value.stdin).toContain('"$cli" messages --channel');
    expect(plan.value.stdin).toContain("--limit 10000 --format json");
    expect(plan.value.stdin).not.toContain("cat /srv/source/.comis");
  });

  it("parses only the bounded content-free attestation envelope", () => {
    expect(parseProductionMessagesAttestation(facts())).toEqual({
      ok: true,
      value: {
        schema: "comis-offline-messages-attestation",
        schemaVersion: 1,
        channel: "telegram",
        limit: 10_000,
        count: 36,
        bytes: 22_075,
        digestSha256: HISTORY_DIGEST,
        truncated: false,
      },
    });
    const malformed = parseProductionMessagesAttestation(
      facts().replace('"truncated":false', '"truncated":false,"body":"private"'),
    );
    expect(malformed.ok).toBe(false);
  });

  it("attests identical source and target histories using each SSH port", async () => {
    const invocations: Array<{ label: string; host: string; port?: number }> = [];

    const result = await executeProductionMessagesAttestation(
      profile(),
      "telegram",
      {
        run: async (invocation) => {
          invocations.push({
            label: invocation.label,
            host: invocation.host,
            ...(invocation.port !== undefined ? { port: invocation.port } : {}),
          });
          return ok({ stdout: facts(), exitCode: 0 });
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      exact: true,
      source: expect.objectContaining({ count: 36, digestSha256: HISTORY_DIGEST }),
      target: expect.objectContaining({ count: 36, digestSha256: HISTORY_DIGEST }),
    });
    expect(invocations).toEqual([
      { label: "messages-attest-source", host: "source-box", port: 2222 },
      { label: "messages-attest-target", host: "test-box", port: 2202 },
    ]);
  });

  it("fails closed on history mismatch or a ten-thousand-message cap", async () => {
    let calls = 0;
    const mismatch = await executeProductionMessagesAttestation(
      profile(),
      "telegram",
      {
        run: async () => {
          calls += 1;
          return ok({
            stdout: calls === 1 ? facts() : facts(36, "d".repeat(64)),
            exitCode: 0,
          });
        },
      },
    );
    expect(mismatch).toMatchObject({ ok: false, error: { kind: "history_mismatch" } });

    const capped = await executeProductionMessagesAttestation(profile(), "telegram", {
      run: async () => ok({ stdout: facts(10_000), exitCode: 0 }),
    });
    expect(capped).toMatchObject({ ok: false, error: { kind: "history_truncated" } });
  });

  it("does not forward remote errors or malformed raw output", async () => {
    const remote = await executeProductionMessagesAttestation(profile(), "telegram", {
      run: async () => err({ kind: "remote", message: "private prompt from stderr" }),
    });
    expect(JSON.stringify(remote)).not.toContain("private prompt");
    expect(remote).toMatchObject({ ok: false, error: { kind: "remote_failure" } });

    const malformed = await executeProductionMessagesAttestation(profile(), "telegram", {
      run: async () => ok({ stdout: "private raw prompt", exitCode: 0 }),
    });
    expect(JSON.stringify(malformed)).not.toContain("private raw prompt");
    expect(malformed).toMatchObject({ ok: false, error: { kind: "malformed_attestation" } });
  });
});
