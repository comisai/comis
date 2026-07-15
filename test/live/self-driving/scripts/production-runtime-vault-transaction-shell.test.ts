import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runtimeVaultJournalPhaseFile } from "./production-runtime-vault-journal-shell.js";
import {
  classifyProductionRuntimeVaultTransaction,
  parseProductionRuntimeVaultTransactionObservation,
  type ProductionRuntimeVaultJournalPhase,
} from "./production-runtime-vault-transaction.js";
import { buildProductionRuntimeVaultTransactionObservationProgram } from "./production-runtime-vault-transaction-shell.js";

const roots: string[] = [];
const authorityDigest = "a".repeat(64);
const transactionIdentity = "b".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly root: string;
  readonly transactionParent: string;
  readonly transactionDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "comis-runtime-observation-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const transactionParent = join(root, "transactions");
  mkdirSync(transactionParent, { mode: 0o700 });
  return {
    root,
    transactionParent,
    transactionDir: join(transactionParent, "1".repeat(32)),
  };
}

function manifest(authority = authorityDigest, identity = transactionIdentity): string {
  return [
    "COMIS_RUNTIME_VAULT_TRANSACTION_V1_BEGIN",
    `authorityDigestSha256=${authority}`,
    `transactionIdentitySha256=${identity}`,
    "COMIS_RUNTIME_VAULT_TRANSACTION_V1_END",
    "",
  ].join("\n");
}

function secureWrite(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o400 });
  chmodSync(path, 0o400);
}

function createJournal(
  target: ReturnType<typeof fixture>,
  phases: readonly ProductionRuntimeVaultJournalPhase[] = [],
  authority = authorityDigest,
  identity = transactionIdentity,
): void {
  mkdirSync(target.transactionDir, { mode: 0o700 });
  secureWrite(join(target.transactionDir, "manifest"), manifest(authority, identity));
  for (const phase of phases) {
    secureWrite(
      join(target.transactionDir, runtimeVaultJournalPhaseFile(phase)),
      `${phase}\n`,
    );
  }
}

function observe(
  target: ReturnType<typeof fixture>,
  finalState: "absent" | "exact" | "conflict" = "absent",
): ReturnType<typeof spawnSync> {
  return spawnSync(
    "bash",
    [
      "-s",
      "--",
      target.transactionParent,
      target.transactionDir,
      authorityDigest,
      transactionIdentity,
      finalState,
    ],
    {
      encoding: "utf8",
      input: buildProductionRuntimeVaultTransactionObservationProgram(
        process.getuid?.() ?? 0,
        process.getgid?.() ?? 0,
        false,
      ),
    },
  );
}

function parse(raw: string) {
  return parseProductionRuntimeVaultTransactionObservation(
    raw,
    authorityDigest,
    transactionIdentity,
  );
}

describe("production runtime vault target transaction observation", () => {
  it("emits canonical absent and valid histories without changing the journal", () => {
    const absent = fixture();
    const absentResult = observe(absent, "exact");
    expect(absentResult.status, String(absentResult.stderr)).toBe(0);
    expect(parse(String(absentResult.stdout))).toMatchObject({
      ok: true,
      value: { transactionState: "absent", finalState: "exact" },
    });

    const present = fixture();
    createJournal(present, ["prepare_intent", "prepared"]);
    const before = readFileSync(join(present.transactionDir, "manifest"));
    const presentResult = observe(present);
    expect(presentResult.status, String(presentResult.stderr)).toBe(0);
    expect(parse(String(presentResult.stdout))).toEqual({
      ok: true,
      value: {
        transactionState: "present",
        manifestState: "valid",
        authorityDigestSha256: authorityDigest,
        transactionIdentitySha256: transactionIdentity,
        expectedAuthorityDigestSha256: authorityDigest,
        expectedTransactionIdentitySha256: transactionIdentity,
        phases: ["prepare_intent", "prepared"],
        finalState: "absent",
      },
    });
    expect(readFileSync(join(present.transactionDir, "manifest"))).toEqual(before);
  });

  it("reports foreign authenticated manifest identities for explicit classification", () => {
    const target = fixture();
    createJournal(target, [], "c".repeat(64), "d".repeat(64));

    const result = observe(target);
    expect(result.status, String(result.stderr)).toBe(0);
    const parsed = parse(String(result.stdout));
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        manifestState: "valid",
        authorityDigestSha256: "c".repeat(64),
        transactionIdentitySha256: "d".repeat(64),
      },
    });
    expect(parsed.ok && classifyProductionRuntimeVaultTransaction(parsed.value)).toMatchObject({
      ok: false,
      error: { kind: "foreign_transaction" },
    });
  });

  it("recognizes every bounded journal publication crash prefix as recoverable", () => {
    const emptyDirectory = fixture();
    mkdirSync(emptyDirectory.transactionDir, { mode: 0o700 });
    expect(parse(String(observe(emptyDirectory).stdout))).toMatchObject({
      ok: true,
      value: { manifestState: "valid", phases: [] },
    });

    const partialManifest = fixture();
    mkdirSync(partialManifest.transactionDir, { mode: 0o700 });
    secureWrite(
      join(partialManifest.transactionDir, ".incoming-manifest"),
      manifest().slice(0, 47),
    );
    expect(parse(String(observe(partialManifest).stdout))).toMatchObject({
      ok: true,
      value: { manifestState: "valid", phases: [] },
    });

    const partialPhase = fixture();
    createJournal(partialPhase, ["prepare_intent"]);
    secureWrite(join(partialPhase.transactionDir, ".incoming-prepared"), "prep");
    expect(parse(String(observe(partialPhase).stdout))).toMatchObject({
      ok: true,
      value: { phases: ["prepare_intent"] },
    });

    const linkedPhase = fixture();
    createJournal(linkedPhase, ["prepare_intent"]);
    const incoming = join(linkedPhase.transactionDir, ".incoming-prepared");
    const final = join(
      linkedPhase.transactionDir,
      runtimeVaultJournalPhaseFile("prepared"),
    );
    secureWrite(incoming, "prepared\n");
    linkSync(incoming, final);
    expect(parse(String(observe(linkedPhase).stdout))).toMatchObject({
      ok: true,
      value: { phases: ["prepare_intent", "prepared"] },
    });
  });

  it("bounds hostile journal state to a content-free corrupt observation", () => {
    const corruptFixtures: ReturnType<typeof fixture>[] = [];

    const unknown = fixture();
    createJournal(unknown);
    secureWrite(join(unknown.transactionDir, "decoy"), "secret material");
    corruptFixtures.push(unknown);

    const badMode = fixture();
    createJournal(badMode);
    chmodSync(join(badMode.transactionDir, "manifest"), 0o600);
    corruptFixtures.push(badMode);

    const symlink = fixture();
    mkdirSync(symlink.transactionDir, { mode: 0o700 });
    symlinkSync(symlink.root, join(symlink.transactionDir, "manifest"));
    corruptFixtures.push(symlink);

    const unrelatedLink = fixture();
    createJournal(unrelatedLink, ["prepare_intent"]);
    const unrelated = join(unrelatedLink.transactionDir, ".incoming-prepared");
    secureWrite(unrelated, "prepared\n");
    linkSync(unrelated, join(unrelatedLink.root, "unrelated"));
    corruptFixtures.push(unrelatedLink);

    for (const target of corruptFixtures) {
      const result = observe(target, "conflict");
      expect(result.status, String(result.stderr)).toBe(0);
      expect(String(result.stdout)).not.toContain("secret material");
      expect(parse(String(result.stdout))).toMatchObject({
        ok: true,
        value: {
          transactionState: "present",
          manifestState: "corrupt",
          phases: [],
          finalState: "conflict",
        },
      });
    }
  });

  it("is syntactically valid and requires canonical caller bindings", () => {
    const program = buildProductionRuntimeVaultTransactionObservationProgram();
    expect(spawnSync("bash", ["-n"], { input: program }).status).toBe(0);
    expect(program).toContain("O_NOFOLLOW");
    expect(program).toContain("listxattr");
    expect(program).not.toContain("rm -rf");

    const target = fixture();
    const invalid = spawnSync(
      "bash",
      ["-s", "--", target.transactionParent, target.transactionDir, "bad", transactionIdentity, "absent"],
      { encoding: "utf8", input: program },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe("");
  });
});
