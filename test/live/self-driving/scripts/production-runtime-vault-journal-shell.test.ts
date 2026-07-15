import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildProductionRuntimeVaultJournalShellLibrary,
  runtimeVaultJournalPhaseFile,
} from "./production-runtime-vault-journal-shell.js";

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
  const root = mkdtempSync(join(tmpdir(), "comis-runtime-journal-"));
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

function run(
  target: ReturnType<typeof fixture>,
  operations: readonly string[],
): ReturnType<typeof spawnSync> {
  const script = [
    "set -euo pipefail",
    `transaction_parent=${JSON.stringify(target.transactionParent)}`,
    `transaction_dir=${JSON.stringify(target.transactionDir)}`,
    `expected_authority_digest=${authorityDigest}`,
    `expected_transaction_identity=${transactionIdentity}`,
    buildProductionRuntimeVaultJournalShellLibrary(
      process.getuid?.() ?? 0,
      process.getgid?.() ?? 0,
      false,
    ),
    ...operations,
    "",
  ].join("\n");
  return spawnSync("bash", ["-s"], { encoding: "utf8", input: script });
}

describe("production runtime vault target journal shell", () => {
  it("creates the exact durable forward journal and accepts current-phase retries", () => {
    const target = fixture();
    const phases = [
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
    const result = run(target, [
      "runtime_journal_initialize",
      ...phases.map((phase) => `runtime_journal_append ${phase}`),
      "runtime_journal_append cleanup_complete",
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(readdirSync(target.transactionDir).sort()).toEqual(
      ["manifest", ...phases.map(runtimeVaultJournalPhaseFile)].sort(),
    );
    expect(readFileSync(join(target.transactionDir, "manifest"), "utf8")).toBe(
      [
        "COMIS_RUNTIME_VAULT_TRANSACTION_V1_BEGIN",
        `authorityDigestSha256=${authorityDigest}`,
        `transactionIdentitySha256=${transactionIdentity}`,
        "COMIS_RUNTIME_VAULT_TRANSACTION_V1_END",
        "",
      ].join("\n"),
    );
    for (const name of readdirSync(target.transactionDir)) {
      expect(Number(lstatSync(join(target.transactionDir, name)).mode & 0o7777)).toBe(0o400);
      expect(lstatSync(join(target.transactionDir, name)).nlink).toBe(1);
    }
  });

  it("rejects skipped phases, invalid rollback order, and post-terminal appends", () => {
    for (const operations of [
      ["runtime_journal_initialize", "runtime_journal_append prepared"],
      ["runtime_journal_initialize", "runtime_journal_append rolled_back"],
      [
        "runtime_journal_initialize",
        "runtime_journal_append prepare_intent",
        "runtime_journal_append rollback_intent",
        "runtime_journal_append verified",
      ],
    ]) {
      const result = run(fixture(), operations);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("persists a valid rollback terminal prefix", () => {
    const target = fixture();
    const result = run(target, [
      "runtime_journal_initialize",
      "runtime_journal_append prepare_intent",
      "runtime_journal_append prepared",
      "runtime_journal_append rollback_intent",
      "runtime_journal_append rolled_back",
      "runtime_journal_append rolled_back",
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(readdirSync(target.transactionDir)).toContain(
      runtimeVaultJournalPhaseFile("rolled_back"),
    );
  });

  it("recovers bounded partial writes and the link-before-unlink crash topology", () => {
    const partialManifest = fixture();
    mkdirSync(partialManifest.transactionDir, { mode: 0o700 });
    writeFileSync(
      join(partialManifest.transactionDir, ".incoming-manifest"),
      "COMIS_RUNTIME_VAULT_TRANSACTION_V1_",
      { mode: 0o400 },
    );
    expect(run(partialManifest, ["runtime_journal_initialize"]).status).toBe(0);

    const linkedPhase = fixture();
    expect(
      run(linkedPhase, [
        "runtime_journal_initialize",
        "runtime_journal_append prepare_intent",
      ]).status,
    ).toBe(0);
    const incoming = join(linkedPhase.transactionDir, ".incoming-prepared");
    const final = join(
      linkedPhase.transactionDir,
      runtimeVaultJournalPhaseFile("prepared"),
    );
    writeFileSync(incoming, "prepared\n", { mode: 0o400 });
    linkSync(incoming, final);
    expect(lstatSync(incoming).nlink).toBe(2);

    const recovered = run(linkedPhase, ["runtime_journal_append prepared"]);
    expect(recovered.status, String(recovered.stderr)).toBe(0);
    expect(lstatSync(final).nlink).toBe(1);
  });

  it("discards an interrupted next phase before durably rolling back", () => {
    const partialNextPhase = fixture();
    expect(
      run(partialNextPhase, [
        "runtime_journal_initialize",
        "runtime_journal_append prepare_intent",
      ]).status,
    ).toBe(0);
    const partial = join(partialNextPhase.transactionDir, ".incoming-prepared");
    writeFileSync(partial, "prep", { mode: 0o400 });

    const rolledBack = run(partialNextPhase, [
      "runtime_journal_append rollback_intent",
      "runtime_journal_append rolled_back",
    ]);

    expect(rolledBack.status, String(rolledBack.stderr)).toBe(0);
    expect(readdirSync(partialNextPhase.transactionDir).sort()).toEqual(
      [
        "100-prepare_intent",
        "900-rollback_intent",
        "910-rolled_back",
        "manifest",
      ].sort(),
    );

    const linkedNextPhase = fixture();
    expect(
      run(linkedNextPhase, [
        "runtime_journal_initialize",
        "runtime_journal_append prepare_intent",
      ]).status,
    ).toBe(0);
    const linkedIncoming = join(linkedNextPhase.transactionDir, ".incoming-prepared");
    const linkedFinal = join(
      linkedNextPhase.transactionDir,
      runtimeVaultJournalPhaseFile("prepared"),
    );
    writeFileSync(linkedIncoming, "prepared\n", { mode: 0o400 });
    linkSync(linkedIncoming, linkedFinal);

    const linkedRollback = run(linkedNextPhase, [
      "runtime_journal_append rollback_intent",
      "runtime_journal_append rolled_back",
    ]);
    expect(linkedRollback.status, String(linkedRollback.stderr)).toBe(0);
    expect(readdirSync(linkedNextPhase.transactionDir)).not.toContain(
      ".incoming-prepared",
    );
    expect(lstatSync(linkedFinal).nlink).toBe(1);
  });

  it("rejects foreign, linked, symlinked, and unexpected journal objects", () => {
    const foreign = fixture();
    expect(run(foreign, ["runtime_journal_initialize"]).status).toBe(0);
    chmodSync(join(foreign.transactionDir, "manifest"), 0o600);
    expect(run(foreign, ["runtime_journal_initialize"]).status).not.toBe(0);

    const symlinked = fixture();
    symlinkSync(symlinked.root, symlinked.transactionDir);
    expect(run(symlinked, ["runtime_journal_initialize"]).status).not.toBe(0);

    const unexpected = fixture();
    expect(run(unexpected, ["runtime_journal_initialize"]).status).toBe(0);
    writeFileSync(join(unexpected.transactionDir, "decoy"), "x", { mode: 0o400 });
    expect(
      run(unexpected, ["runtime_journal_append prepare_intent"]).status,
    ).not.toBe(0);
  });

  it("emits a syntactically valid library with fixed phase filenames", () => {
    const library = buildProductionRuntimeVaultJournalShellLibrary(0);
    expect(spawnSync("bash", ["-n"], { input: library }).status).toBe(0);
    expect(runtimeVaultJournalPhaseFile("publish_intent")).toBe("400-publish_intent");
    expect(library).toContain("O_NOFOLLOW");
    expect(library).toContain("os.fsync");
    expect(library).toContain("os.link");
    expect(library).not.toContain("rm -rf");
  });
});
