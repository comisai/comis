// SPDX-License-Identifier: Apache-2.0
import {
  systemNowMs,
  type ComisLogger,
  type ConfigGitManager,
  type GitCommitMetadata,
} from "@comis/core";
import { err, fromPromise, type Result } from "@comis/shared";

interface ConfigCommitLogFields {
  method: "config.apply" | "config.patch" | "persistToConfig";
  section?: string;
}

/**
 * Commit a config snapshot without letting optional Git history break the
 * authoritative config write. Both rejected promises and returned Result
 * errors are logged as failures; only an ok Result is reported as recorded.
 */
export async function commitConfigVersionBestEffort(
  manager: Pick<ConfigGitManager, "commit">,
  metadata: GitCommitMetadata,
  logger: ComisLogger,
  fields: ConfigCommitLogFields,
): Promise<Result<string, string>> {
  const startMs = systemNowMs();
  const boundary = await fromPromise(manager.commit(metadata));
  const result = boundary.ok ? boundary.value : err(boundary.error.message);

  if (!result.ok) {
    logger.debug(
      {
        ...fields,
        durationMs: systemNowMs() - startMs,
        outcome: "failure",
        err: result.error,
      },
      "Git commit failed (best-effort)",
    );
    return result;
  }

  logger.debug(
    {
      ...fields,
      durationMs: systemNowMs() - startMs,
      outcome: "success",
    },
    "Git commit recorded",
  );
  return result;
}
