// SPDX-License-Identifier: Apache-2.0

import type { CompletionAttachmentShape } from "./announcement-ports.js";

export interface CompletionAnnouncementOperation {
  readonly text: string;
  readonly partId?: string;
  readonly attachment?: CompletionAttachmentShape;
  readonly attachmentIndex?: number;
}

export interface CompletionAnnouncementOperationPlan {
  readonly operations: readonly CompletionAnnouncementOperation[];
  readonly pathReplacements: number;
}

export function createCompletionAnnouncementOperationPlan(
  text: string,
  attachments: readonly CompletionAttachmentShape[],
): CompletionAnnouncementOperationPlan {
  let sanitizedText = text;
  let pathReplacements = 0;

  for (const attachment of attachments) {
    const fileName = attachment.path.split(/[\\/]/).filter(Boolean).at(-1);
    if (!fileName || !sanitizedText.includes(attachment.path)) continue;
    const parts = sanitizedText.split(attachment.path);
    pathReplacements += parts.length - 1;
    sanitizedText = parts.join(fileName);
  }

  if (attachments.length === 0) {
    return { operations: [{ text: sanitizedText }], pathReplacements };
  }

  return {
    operations: [
      ...(sanitizedText.length > 0
        ? [{ text: sanitizedText, partId: "summary" }]
        : []),
      ...attachments.map((attachment, attachmentIndex) => ({
        text: "",
        partId: `attachment:${attachmentIndex}`,
        attachment,
        attachmentIndex,
      })),
    ],
    pathReplacements,
  };
}
