// SPDX-License-Identifier: Apache-2.0
/** Provider-shape repair for Bedrock turns whose current tool registry is empty. */

export interface BedrockToolHistoryRewrite {
  readonly messages: Array<Record<string, unknown>>;
  readonly toolBlocksStripped: number;
  readonly messagesDropped: number;
  readonly messagesMerged: number;
}

function isToolProtocolBlock(block: Record<string, unknown>): boolean {
  return block.toolUse !== undefined || block.toolResult !== undefined;
}

function isCachePointBlock(block: Record<string, unknown>): boolean {
  return block.cachePoint !== undefined;
}

/**
 * Bedrock rejects historical tool protocol blocks when the current request has
 * no `toolConfig`. Remove only those provider-native blocks, discard messages
 * left with cache markers alone, and restore role alternation by merging
 * adjacent messages with the same role.
 */
export function stripBedrockToolHistory(
  messages: Array<Record<string, unknown>>,
): BedrockToolHistoryRewrite {
  let toolBlocksStripped = 0;
  let messagesDropped = 0;
  let messagesMerged = 0;
  const rewritten: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      rewritten.push(message);
      continue;
    }

    const content = message.content as Array<Record<string, unknown>>;
    const retained = content.filter((block) => {
      const strip = isToolProtocolBlock(block);
      if (strip) toolBlocksStripped++;
      return !strip;
    });
    const hasSemanticContent = retained.some((block) => !isCachePointBlock(block));
    if (!hasSemanticContent) {
      messagesDropped++;
      continue;
    }

    const nextMessage = retained.length === content.length
      ? message
      : { ...message, content: retained };
    const previous = rewritten[rewritten.length - 1];
    if (
      previous?.role === nextMessage.role
      && Array.isArray(previous.content)
    ) {
      previous.content = [
        ...(previous.content as Array<Record<string, unknown>>),
        ...retained,
      ];
      messagesMerged++;
      continue;
    }
    rewritten.push(nextMessage);
  }

  return { messages: rewritten, toolBlocksStripped, messagesDropped, messagesMerged };
}
