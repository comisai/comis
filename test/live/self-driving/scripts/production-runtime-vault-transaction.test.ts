import { describe, expect, it } from "vitest";

import {
  RUNTIME_VAULT_FORWARD_PHASES,
  classifyProductionRuntimeVaultTransaction,
  validateProductionRuntimeVaultJournal,
  type ProductionRuntimeVaultJournalPhase,
} from "./production-runtime-vault-transaction.js";

const authorityDigestSha256 = "a".repeat(64);
const transactionIdentitySha256 = "b".repeat(64);

function classify(
  phases: readonly ProductionRuntimeVaultJournalPhase[],
  finalState: "absent" | "exact" | "conflict" = "absent",
) {
  return classifyProductionRuntimeVaultTransaction({
    transactionState: "present",
    manifestState: "valid",
    authorityDigestSha256,
    transactionIdentitySha256,
    expectedAuthorityDigestSha256: authorityDigestSha256,
    expectedTransactionIdentitySha256: transactionIdentitySha256,
    phases,
    finalState,
  });
}

describe("production runtime vault transaction journal", () => {
  it("accepts every durable forward prefix and both terminal histories", () => {
    for (let length = 0; length <= RUNTIME_VAULT_FORWARD_PHASES.length; length += 1) {
      const phases = RUNTIME_VAULT_FORWARD_PHASES.slice(0, length);
      expect(validateProductionRuntimeVaultJournal(phases)).toEqual({
        ok: true,
        value: phases,
      });
    }

    expect(
      validateProductionRuntimeVaultJournal([
        "prepare_intent",
        "prepared",
        "receive_intent",
        "rollback_intent",
        "rolled_back",
      ]),
    ).toEqual({
      ok: true,
      value: [
        "prepare_intent",
        "prepared",
        "receive_intent",
        "rollback_intent",
        "rolled_back",
      ],
    });
  });

  it("rejects skipped, duplicated, reordered, post-terminal, and unknown phases", () => {
    for (const phases of [
      ["prepared"],
      ["prepare_intent", "prepare_intent"],
      ["prepare_intent", "receive_intent"],
      ["prepare_intent", "rolled_back"],
      ["prepare_intent", "rollback_intent", "verified"],
      [...RUNTIME_VAULT_FORWARD_PHASES, "rollback_intent"],
      ["prepare_intent", "unknown"],
    ]) {
      expect(
        validateProductionRuntimeVaultJournal(
          phases as readonly ProductionRuntimeVaultJournalPhase[],
        ).ok,
      ).toBe(false);
    }
  });

  it("distinguishes untouched, reusable, active, and conflicting absent transactions", () => {
    expect(
      classifyProductionRuntimeVaultTransaction({
        transactionState: "absent",
        expectedAuthorityDigestSha256: authorityDigestSha256,
        expectedTransactionIdentitySha256: transactionIdentitySha256,
        finalState: "absent",
      }),
    ).toEqual({ ok: true, value: { disposition: "not_started" } });
    expect(
      classifyProductionRuntimeVaultTransaction({
        transactionState: "absent",
        expectedAuthorityDigestSha256: authorityDigestSha256,
        expectedTransactionIdentitySha256: transactionIdentitySha256,
        finalState: "exact",
      }),
    ).toEqual({ ok: true, value: { disposition: "reused_existing" } });
    expect(classify([], "absent")).toEqual({
      ok: true,
      value: { disposition: "transaction_active", nextAction: "roll_back" },
    });
    expect(
      classifyProductionRuntimeVaultTransaction({
        transactionState: "absent",
        expectedAuthorityDigestSha256: authorityDigestSha256,
        expectedTransactionIdentitySha256: transactionIdentitySha256,
        finalState: "conflict",
      }),
    ).toMatchObject({ ok: false, error: { kind: "blocked_corrupt" } });
  });

  it("recovers the publication linearization point without deleting exact payloads", () => {
    const beforeRename = RUNTIME_VAULT_FORWARD_PHASES.slice(
      0,
      RUNTIME_VAULT_FORWARD_PHASES.indexOf("publish_intent") + 1,
    );
    expect(classify(beforeRename, "absent")).toEqual({
      ok: true,
      value: { disposition: "transaction_active", nextAction: "roll_back" },
    });
    expect(classify(beforeRename, "exact")).toEqual({
      ok: true,
      value: { disposition: "published_recovered", nextAction: "finish_publish" },
    });
    expect(
      classify(RUNTIME_VAULT_FORWARD_PHASES.slice(0, -1), "exact"),
    ).toEqual({
      ok: true,
      value: { disposition: "published_recovered", nextAction: "finish_publish" },
    });
    expect(classify(RUNTIME_VAULT_FORWARD_PHASES, "exact")).toEqual({
      ok: true,
      value: { disposition: "published_complete" },
    });
    expect(classify(RUNTIME_VAULT_FORWARD_PHASES, "absent")).toMatchObject({
      ok: false,
      error: { kind: "blocked_corrupt" },
    });
  });

  it("recognizes rolled-back authority and blocks impossible rollback evidence", () => {
    const rolledBack = [
      "prepare_intent",
      "prepared",
      "rollback_intent",
      "rolled_back",
    ] as const;
    expect(classify(rolledBack, "absent")).toEqual({
      ok: true,
      value: { disposition: "already_rolled_back" },
    });
    expect(classify(rolledBack, "exact")).toMatchObject({
      ok: false,
      error: { kind: "blocked_corrupt" },
    });
    expect(classify(rolledBack.slice(0, -1), "absent")).toEqual({
      ok: true,
      value: { disposition: "transaction_active", nextAction: "finish_rollback" },
    });
  });

  it("separates foreign authority from malformed or impossible local state", () => {
    expect(
      classifyProductionRuntimeVaultTransaction({
        transactionState: "present",
        manifestState: "valid",
        authorityDigestSha256: "c".repeat(64),
        transactionIdentitySha256,
        expectedAuthorityDigestSha256: authorityDigestSha256,
        expectedTransactionIdentitySha256: transactionIdentitySha256,
        phases: [],
        finalState: "absent",
      }),
    ).toMatchObject({ ok: false, error: { kind: "foreign_transaction" } });
    expect(
      classifyProductionRuntimeVaultTransaction({
        transactionState: "present",
        manifestState: "corrupt",
        expectedAuthorityDigestSha256: authorityDigestSha256,
        expectedTransactionIdentitySha256: transactionIdentitySha256,
        phases: [],
        finalState: "absent",
      }),
    ).toMatchObject({ ok: false, error: { kind: "blocked_corrupt" } });
    expect(classify(["prepare_intent", "verified"] as const, "absent")).toMatchObject({
      ok: false,
      error: { kind: "blocked_corrupt" },
    });
  });
});
