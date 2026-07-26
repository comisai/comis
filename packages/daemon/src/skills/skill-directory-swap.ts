// SPDX-License-Identifier: Apache-2.0
/** Stage and atomically swap one live skill directory with rollback support. */
import {
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { safePath } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import type { SkillBundleFile } from "@comis/skills";
import { err, ok, tryCatch, type Result } from "@comis/shared";

export interface SkillDirectoryTransaction {
  /** Keep the candidate and delete the private incumbent backup. */
  finalize(): Result<void, Error>;
  /** Remove the candidate and restore the complete incumbent, when present. */
  rollback(): Result<void, Error>;
}

export interface InstallSkillDirectoryArgs {
  readonly skillsBaseDir: string;
  readonly skillDir: string;
  readonly files: readonly SkillBundleFile[];
}

function cleanup(path: string): Result<void, Error> {
  const removed = tryCatch(() => rmSync(path, { recursive: true, force: true }));
  return removed.ok ? ok(undefined) : removed;
}

function writeStagedFiles(
  stageDir: string,
  files: readonly SkillBundleFile[],
): Result<void, Error> {
  for (const file of files) {
    const path = safePath(stageDir, ...file.path.split("/"));
    const parent = dirname(path);
    const ensured = ensureContainedDir({
      dir: parent,
      mode: 0o700,
      confinedBaseDir: stageDir,
    });
    if (!ensured.ok) return err(ensured.error);
    const written = writeRegularFile({
      path,
      content: typeof file.content === "string" ? file.content : Buffer.from(file.content),
      confinedBaseDir: stageDir,
    });
    if (!written.ok) return err(written.error);
  }
  return ok(undefined);
}

/** Install a staged candidate and return the transaction completion controls. */
export function installSkillDirectory(
  args: InstallSkillDirectoryArgs,
): Result<SkillDirectoryTransaction, Error> {
  const base = ensureContainedDir({ dir: args.skillsBaseDir, mode: 0o700 });
  if (!base.ok) return err(base.error);
  const swapParent = dirname(args.skillsBaseDir);
  const madeRoot = tryCatch(() =>
    mkdtempSync(safePath(swapParent, ".skill-import-swap-")),
  );
  if (!madeRoot.ok) return madeRoot;
  const swapRoot = madeRoot.value;
  const stageDir = safePath(swapRoot, "next");
  const backupDir = safePath(swapRoot, "previous");
  const stage = ensureContainedDir({
    dir: stageDir,
    mode: 0o700,
    confinedBaseDir: swapRoot,
  });
  if (!stage.ok) {
    cleanup(swapRoot);
    return err(stage.error);
  }
  const staged = writeStagedFiles(stageDir, args.files);
  if (!staged.ok) {
    cleanup(swapRoot);
    return staged;
  }

  const hadIncumbent = existsSync(args.skillDir);
  if (hadIncumbent) {
    const movedOld = tryCatch(() => renameSync(args.skillDir, backupDir));
    if (!movedOld.ok) {
      cleanup(swapRoot);
      return movedOld;
    }
  }
  const movedNew = tryCatch(() => renameSync(stageDir, args.skillDir));
  if (!movedNew.ok) {
    if (hadIncumbent) {
      const restored = tryCatch(() => renameSync(backupDir, args.skillDir));
      if (!restored.ok) {
        return err(
          new Error(
            `Skill directory swap failed and incumbent restoration also failed: ${restored.error.message}`,
          ),
        );
      }
    }
    cleanup(swapRoot);
    return movedNew;
  }

  let completed: "open" | "finalized" | "rolled_back" = "open";
  return ok({
    finalize(): Result<void, Error> {
      if (completed !== "open") {
        return err(new Error(`Skill directory transaction is already ${completed}`));
      }
      const removed = cleanup(swapRoot);
      if (removed.ok) completed = "finalized";
      return removed;
    },
    rollback(): Result<void, Error> {
      if (completed !== "open") {
        return err(new Error(`Skill directory transaction is already ${completed}`));
      }
      const candidateRemoved = cleanup(args.skillDir);
      if (!candidateRemoved.ok) return candidateRemoved;
      if (hadIncumbent) {
        const restored = tryCatch(() => renameSync(backupDir, args.skillDir));
        if (!restored.ok) return restored;
      }
      const removed = cleanup(swapRoot);
      if (removed.ok) completed = "rolled_back";
      return removed;
    },
  });
}
