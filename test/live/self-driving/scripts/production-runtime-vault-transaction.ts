// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";

export const RUNTIME_VAULT_FORWARD_PHASES = [
  "prepare_intent",
  "prepared",
  "receive_intent",
  "received",
  "verify_intent",
  "verified",
  "publish_intent",
  "published",
  "cleanup_complete",
] as const;

export const RUNTIME_VAULT_ROLLBACK_PHASES = [
  "rollback_intent",
  "rolled_back",
] as const;

export const RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN =
  "COMIS_RUNTIME_VAULT_TRANSACTION_STATUS_V1_BEGIN";
export const RUNTIME_VAULT_TRANSACTION_STATUS_END =
  "COMIS_RUNTIME_VAULT_TRANSACTION_STATUS_V1_END";

export type ProductionRuntimeVaultJournalPhase =
  | (typeof RUNTIME_VAULT_FORWARD_PHASES)[number]
  | (typeof RUNTIME_VAULT_ROLLBACK_PHASES)[number];

export interface ProductionRuntimeVaultJournalError {
  readonly kind: "invalid_journal";
  readonly message: string;
}

export type ProductionRuntimeVaultTransactionObservation =
  | {
      readonly transactionState: "absent";
      readonly expectedAuthorityDigestSha256: string;
      readonly expectedTransactionIdentitySha256: string;
      readonly finalState: "absent" | "exact" | "conflict";
    }
  | {
      readonly transactionState: "present";
      readonly manifestState: "corrupt";
      readonly expectedAuthorityDigestSha256: string;
      readonly expectedTransactionIdentitySha256: string;
      readonly phases: readonly ProductionRuntimeVaultJournalPhase[];
      readonly finalState: "absent" | "exact" | "conflict";
    }
  | {
      readonly transactionState: "present";
      readonly manifestState: "valid";
      readonly authorityDigestSha256: string;
      readonly transactionIdentitySha256: string;
      readonly expectedAuthorityDigestSha256: string;
      readonly expectedTransactionIdentitySha256: string;
      readonly phases: readonly ProductionRuntimeVaultJournalPhase[];
      readonly finalState: "absent" | "exact" | "conflict";
    };

export type ProductionRuntimeVaultTransactionDisposition =
  | { readonly disposition: "not_started" }
  | { readonly disposition: "reused_existing" }
  | {
      readonly disposition: "transaction_active";
      readonly nextAction: "roll_back" | "finish_rollback";
    }
  | {
      readonly disposition: "published_recovered";
      readonly nextAction: "finish_publish";
    }
  | { readonly disposition: "published_complete" }
  | { readonly disposition: "already_rolled_back" };

export type ProductionRuntimeVaultTransactionError =
  | {
      readonly kind: "foreign_transaction";
      readonly message: string;
    }
  | {
      readonly kind: "blocked_corrupt";
      readonly message: string;
    };

const PHASES = new Set<string>([
  ...RUNTIME_VAULT_FORWARD_PHASES,
  ...RUNTIME_VAULT_ROLLBACK_PHASES,
]);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const MAX_TRANSACTION_STATUS_BYTES = 4_096;
const FINAL_STATES = new Set<string>(["absent", "exact", "conflict"]);

function invalidJournal(): Result<never, ProductionRuntimeVaultJournalError> {
  return err({
    kind: "invalid_journal",
    message: "Runtime vault journal is not an append-only valid phase history",
  });
}

function isForwardPrefix(phases: readonly string[]): boolean {
  return phases.every((phase, index) => RUNTIME_VAULT_FORWARD_PHASES.at(index) === phase);
}

function parseFinalState(
  line: string | undefined,
): "absent" | "exact" | "conflict" | undefined {
  if (line === undefined || !line.startsWith("finalState=")) return undefined;
  const value = line.slice("finalState=".length);
  if (!FINAL_STATES.has(value)) return undefined;
  return value as "absent" | "exact" | "conflict";
}

export function parseProductionRuntimeVaultTransactionObservation(
  raw: string,
  expectedAuthorityDigestSha256: string,
  expectedTransactionIdentitySha256: string,
): Result<
  ProductionRuntimeVaultTransactionObservation,
  ProductionRuntimeVaultJournalError
> {
  if (
    !SHA256_RE.test(expectedAuthorityDigestSha256) ||
    !SHA256_RE.test(expectedTransactionIdentitySha256) ||
    Buffer.byteLength(raw, "utf8") > MAX_TRANSACTION_STATUS_BYTES ||
    raw.includes("\r") ||
    !raw.endsWith("\n")
  ) {
    return invalidJournal();
  }

  const lines = raw.split("\n");
  if (
    lines.at(-1) !== "" ||
    lines[0] !== RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN ||
    lines.at(-2) !== RUNTIME_VAULT_TRANSACTION_STATUS_END
  ) {
    return invalidJournal();
  }
  const body = lines.slice(1, -2);
  if (body[0] === "transactionState=absent") {
    if (body.length !== 2) return invalidJournal();
    const finalState = parseFinalState(body[1]);
    if (finalState === undefined) return invalidJournal();
    return ok({
      transactionState: "absent",
      expectedAuthorityDigestSha256,
      expectedTransactionIdentitySha256,
      finalState,
    });
  }
  if (body[0] !== "transactionState=present") return invalidJournal();

  if (body[1] === "manifestState=corrupt") {
    if (body.length !== 3) return invalidJournal();
    const finalState = parseFinalState(body[2]);
    if (finalState === undefined) return invalidJournal();
    return ok({
      transactionState: "present",
      manifestState: "corrupt",
      expectedAuthorityDigestSha256,
      expectedTransactionIdentitySha256,
      phases: [],
      finalState,
    });
  }
  if (body[1] !== "manifestState=valid" || body.length < 5) {
    return invalidJournal();
  }

  const authorityLine = body[2];
  const identityLine = body[3];
  if (
    authorityLine === undefined ||
    identityLine === undefined ||
    !authorityLine.startsWith("authorityDigestSha256=") ||
    !identityLine.startsWith("transactionIdentitySha256=")
  ) {
    return invalidJournal();
  }
  const authorityDigestSha256 = authorityLine.slice(
    "authorityDigestSha256=".length,
  );
  const transactionIdentitySha256 = identityLine.slice(
    "transactionIdentitySha256=".length,
  );
  if (
    !SHA256_RE.test(authorityDigestSha256) ||
    !SHA256_RE.test(transactionIdentitySha256)
  ) {
    return invalidJournal();
  }

  const finalState = parseFinalState(body.at(-1));
  if (finalState === undefined) return invalidJournal();
  const phaseLines = body.slice(4, -1);
  const phases: ProductionRuntimeVaultJournalPhase[] = [];
  for (const line of phaseLines) {
    if (!line.startsWith("phase=")) return invalidJournal();
    const phase = line.slice("phase=".length);
    if (!PHASES.has(phase)) return invalidJournal();
    phases.push(phase as ProductionRuntimeVaultJournalPhase);
  }
  const journal = validateProductionRuntimeVaultJournal(phases);
  if (!journal.ok) return journal;
  return ok({
    transactionState: "present",
    manifestState: "valid",
    authorityDigestSha256,
    transactionIdentitySha256,
    expectedAuthorityDigestSha256,
    expectedTransactionIdentitySha256,
    phases: journal.value,
    finalState,
  });
}

export function validateProductionRuntimeVaultJournal(
  phases: readonly ProductionRuntimeVaultJournalPhase[],
): Result<readonly ProductionRuntimeVaultJournalPhase[], ProductionRuntimeVaultJournalError> {
  if (phases.some((phase) => typeof phase !== "string" || !PHASES.has(phase))) {
    return invalidJournal();
  }
  const rollbackIndex = phases.indexOf("rollback_intent");
  if (rollbackIndex === -1) {
    if (!isForwardPrefix(phases)) return invalidJournal();
    return ok(phases);
  }
  const forwardPrefix = phases.slice(0, rollbackIndex);
  const rollbackSuffix = phases.slice(rollbackIndex);
  const publishedIndex = RUNTIME_VAULT_FORWARD_PHASES.indexOf("published");
  if (
    !isForwardPrefix(forwardPrefix) ||
    forwardPrefix.length > publishedIndex ||
    (rollbackSuffix.length !== 1 && rollbackSuffix.length !== 2) ||
    rollbackSuffix[0] !== "rollback_intent" ||
    (rollbackSuffix.length === 2 && rollbackSuffix[1] !== "rolled_back")
  ) {
    return invalidJournal();
  }
  return ok(phases);
}

function blocked(): Result<never, ProductionRuntimeVaultTransactionError> {
  return err({
    kind: "blocked_corrupt",
    message: "Runtime vault transaction state is corrupt or impossible",
  });
}

function foreign(): Result<never, ProductionRuntimeVaultTransactionError> {
  return err({
    kind: "foreign_transaction",
    message: "Runtime vault transaction belongs to different recovery authority",
  });
}

export function classifyProductionRuntimeVaultTransaction(
  observation: ProductionRuntimeVaultTransactionObservation,
): Result<
  ProductionRuntimeVaultTransactionDisposition,
  ProductionRuntimeVaultTransactionError
> {
  if (
    !SHA256_RE.test(observation.expectedAuthorityDigestSha256) ||
    !SHA256_RE.test(observation.expectedTransactionIdentitySha256)
  ) {
    return blocked();
  }
  if (observation.transactionState === "absent") {
    if (observation.finalState === "absent") {
      return ok({ disposition: "not_started" });
    }
    if (observation.finalState === "exact") {
      return ok({ disposition: "reused_existing" });
    }
    return blocked();
  }
  if (observation.manifestState === "corrupt") return blocked();
  if (
    !SHA256_RE.test(observation.authorityDigestSha256) ||
    !SHA256_RE.test(observation.transactionIdentitySha256)
  ) {
    return blocked();
  }
  if (
    observation.authorityDigestSha256 !== observation.expectedAuthorityDigestSha256 ||
    observation.transactionIdentitySha256 !==
      observation.expectedTransactionIdentitySha256
  ) {
    return foreign();
  }
  const journal = validateProductionRuntimeVaultJournal(observation.phases);
  if (!journal.ok || observation.finalState === "conflict") return blocked();

  const phases = journal.value;
  const rollbackStarted = phases.includes("rollback_intent");
  const rolledBack = phases.includes("rolled_back");
  const publishIntent = phases.includes("publish_intent");
  const published = phases.includes("published");
  const cleanupComplete = phases.includes("cleanup_complete");

  if (rollbackStarted) {
    if (observation.finalState !== "absent") return blocked();
    if (rolledBack) return ok({ disposition: "already_rolled_back" });
    return ok({ disposition: "transaction_active", nextAction: "finish_rollback" });
  }
  if (observation.finalState === "exact") {
    if (cleanupComplete) return ok({ disposition: "published_complete" });
    if (publishIntent || published) {
      return ok({ disposition: "published_recovered", nextAction: "finish_publish" });
    }
    return blocked();
  }
  if (published || cleanupComplete) return blocked();
  return ok({ disposition: "transaction_active", nextAction: "roll_back" });
}
