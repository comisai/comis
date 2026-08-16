// SPDX-License-Identifier: Apache-2.0

import { fromPromise } from "@comis/shared";
import type { AnnouncementDeadLetterAttachment } from "@comis/core";
import type {
  AnnouncementLogger,
  PreparedRecoveryAttachment,
} from "./announcement-dead-letter-types.js";

type DrainOutcome =
  | "receipt_already_committed"
  | "receipt_committed_now"
  | "suppressed_no_reply"
  | "retained";

export async function drainWithPreparedRecoveryAttachment(params: {
  attachment: AnnouncementDeadLetterAttachment | undefined;
  runId: string;
  logger?: AnnouncementLogger;
  prepareAttachment?: (
    attachment: AnnouncementDeadLetterAttachment,
  ) => Promise<import("@comis/shared").Result<PreparedRecoveryAttachment, Error>>;
  retain(reason: string): void;
  logFailure(
    transition: string,
    errorKind: "precondition" | "validation",
    hint: string,
    message: string,
  ): void;
  drainPrepared(attachment?: PreparedRecoveryAttachment): Promise<DrainOutcome>;
}): Promise<DrainOutcome> {
  if (!params.attachment) return params.drainPrepared();
  if (!params.prepareAttachment) {
    params.retain("attachment_preparation_unavailable");
    params.logFailure(
      "prepare",
      "precondition",
      "wire generated-file validation and snapshotting before recovering the attachment",
      "Dead-letter attachment preparation is unavailable",
    );
    return "retained";
  }
  const prepared = await fromPromise(params.prepareAttachment(params.attachment));
  if (!prepared.ok || !prepared.value.ok) {
    params.retain("attachment_preparation_blocked");
    params.logFailure(
      "prepare",
      "validation",
      "restore the original bounded generated file before recovering the attachment",
      "Dead-letter attachment preparation failed",
    );
    return "retained";
  }
  try {
    return await params.drainPrepared(prepared.value.value);
  } finally {
    const cleaned = await prepared.value.value.cleanup();
    if (!cleaned.ok) {
      params.logger?.warn(
        {
          runId: params.runId,
          errorKind: "resource" as const,
          hint: "Remove stale completion-attachment snapshots and verify their permissions",
        },
        "Dead-letter attachment snapshot cleanup failed",
      );
    }
  }
}
