/**
 * Slack platform action dispatch module.
 *
 * Contains all 12+ action cases extracted from the Slack adapter's
 * platformAction switch statement. Actions include pin/unpin, channel
 * metadata, archival, member management, and bookmarks.
 *
 * @module
 */

import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Execute a Slack platform action by delegating to the appropriate
 * case in the action switch.
 *
 * The `app` parameter uses `{ client: any }` since the Slack adapter
 * already types the Bolt app as `any`. This avoids importing @slack/bolt
 * just for the action module's type.
 */
export async function executeSlackAction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: { client: any },
  action: string,
  params: Record<string, unknown>,
  logger: ComisLogger,
): Promise<Result<unknown, Error>> {
  try {
    switch (action) {
      case "pin": {
        const channelId = String(params.channel_id);
        const messageId = String(params.message_id);
        await app.client.pins.add({ channel: channelId, timestamp: messageId });
        return ok({ pinned: true });
      }
      case "unpin": {
        const channelId = String(params.channel_id);
        const messageId = String(params.message_id);
        await app.client.pins.remove({ channel: channelId, timestamp: messageId });
        return ok({ unpinned: true });
      }
      case "set_topic": {
        const channelId = String(params.channel_id);
        const topic = String(params.topic);
        await app.client.conversations.setTopic({ channel: channelId, topic });
        return ok({ topicSet: true });
      }
      case "set_purpose": {
        const channelId = String(params.channel_id);
        const purpose = String(params.purpose);
        await app.client.conversations.setPurpose({ channel: channelId, purpose });
        return ok({ purposeSet: true });
      }
      case "archive": {
        const channelId = String(params.channel_id);
        await app.client.conversations.archive({ channel: channelId });
        return ok({ archived: true });
      }
      case "unarchive": {
        const channelId = String(params.channel_id);
        await app.client.conversations.unarchive({ channel: channelId });
        return ok({ unarchived: true });
      }
      case "create_channel": {
        const name = String(params.name);
        const isPrivate = params.is_private as boolean | undefined;
        const result = await app.client.conversations.create({
          name,
          is_private: isPrivate,
        });
        return ok({ channelId: result.channel?.id, name });
      }
      case "invite": {
        const channelId = String(params.channel_id);
        const userIds = params.user_ids as string[];
        await app.client.conversations.invite({
          channel: channelId,
          users: userIds.join(","),
        });
        return ok({ invited: true });
      }
      case "kick": {
        const channelId = String(params.channel_id);
        const userId = String(params.user_id);
        await app.client.conversations.kick({ channel: channelId, user: userId });
        return ok({ kicked: true });
      }
      case "channel_info": {
        const channelId = String(params.channel_id);
        const result = await app.client.conversations.info({ channel: channelId });
        const ch = result.channel ?? {};
        return ok({
          id: ch.id,
          name: ch.name,
          topic: ch.topic?.value,
          purpose: ch.purpose?.value,
          isArchived: ch.is_archived,
          memberCount: ch.num_members,
        });
      }
      case "members_list": {
        const channelId = String(params.channel_id);
        const limit = params.limit as number | undefined;
        const result = await app.client.conversations.members({
          channel: channelId,
          limit,
        });
        return ok({ members: result.members });
      }
      case "bookmark_add": {
        const channelId = String(params.channel_id);
        const title = String(params.title);
        const link = String(params.link);
        await app.client.bookmarks.add({
          channel_id: channelId,
          title,
          link,
          type: "link",
        });
        return ok({ bookmarkAdded: true });
      }
      case "sendTyping": {
        // Slack doesn't have a typing indicator API
        return ok({ typing: false, reason: "Slack API does not support typing indicators" });
      }
      default: {
        const unsupportedErr = new Error(`Unsupported action: ${action} on slack`);
        logger.warn(
          {
            channelType: "slack",
            err: unsupportedErr,
            hint: `Action '${action}' is not supported by the Slack adapter`,
            errorKind: "validation" as const,
          },
          "Unsupported platform action",
        );
        return err(unsupportedErr);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Slack action '${action}' failed: ${message}`));
  }
}
