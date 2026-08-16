// SPDX-License-Identifier: Apache-2.0

import type { AnnouncementDeadLetterAttachmentSnapshot } from "@comis/core";

type DrainOutcome =
  | "receipt_already_committed"
  | "receipt_committed_now"
  | "retained";

export async function drainWithPreparedRecoveryAttachment(params: {
  attachment: AnnouncementDeadLetterAttachmentSnapshot | undefined;
  drainPrepared(attachment?: AnnouncementDeadLetterAttachmentSnapshot): Promise<DrainOutcome>;
}): Promise<DrainOutcome> {
  return params.drainPrepared(params.attachment);
}
