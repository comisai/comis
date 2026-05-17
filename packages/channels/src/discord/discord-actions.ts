// SPDX-License-Identifier: Apache-2.0
/**
 * Discord platform action dispatch module.
 *
 * Contains all 23+ action cases extracted from the Discord adapter's
 * platformAction switch statement. Actions include moderation, channel
 * management, thread operations, presence, and polls.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { normalizePollDurationHours } from "@comis/core";
import {
  ActivityType,
  ChannelType,
  type Client,
  type GuildChannelManager,
  type TextChannel,
} from "discord.js";
// Discord channel narrowing helpers replace untyped-cast call sites.
// asTextLike returns a structural-subset DiscordTextLikeChannel for
// text-like channels (messages/send/edit/delete/setTopic/setRateLimitPerUser/
// sendTyping/threads.*); asThreadInfo returns DiscordThreadInfo for the
// threadList iteration sites. The DiscordTextLikeChannel type is imported
// for one site (channel_info) that extends it with optional read-only
// metadata fields (name/topic) at a single local-projection cast site.
import { asTextLike, asThreadInfo } from "./discord-adapter-types.js";
import type { DiscordTextLikeChannel, DiscordThreadInfo } from "./discord-adapter-types.js";

/**
 * Execute a Discord platform action by delegating to the appropriate
 * case in the action switch.
 */
export async function executeDiscordAction(
  client: Client,
  action: string,
  params: Record<string, unknown>,
  logger: ComisLogger,
): Promise<Result<unknown, Error>> {
  try {
    switch (action) {
      case "pin": {
        const channelId = String(params.channel_id);
        const messageId = String(params.message_id);
        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) return err(new Error(`Channel ${channelId} is not a text-based channel`));
        const msg = await tc.messages.fetch(messageId);
        await msg.pin();
        return ok({ pinned: true, channelId, messageId });
      }
      case "unpin": {
        const channelId = String(params.channel_id);
        const messageId = String(params.message_id);
        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) return err(new Error(`Channel ${channelId} is not a text-based channel`));
        const msg = await tc.messages.fetch(messageId);
        await msg.unpin();
        return ok({ unpinned: true, channelId, messageId });
      }
      case "kick": {
        const guildId = String(params.guild_id);
        const userId = String(params.user_id);
        const reason = params.reason ? String(params.reason) : undefined;
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.kick(reason);
        return ok({ kicked: true, userId, guildId });
      }
      case "ban": {
        const guildId = String(params.guild_id);
        const userId = String(params.user_id);
        const reason = params.reason ? String(params.reason) : undefined;
        const days = params.delete_message_days ? Number(params.delete_message_days) : 0;
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.ban({ reason, deleteMessageSeconds: days * 86400 });
        return ok({ banned: true, userId, guildId });
      }
      case "unban": {
        const guildId = String(params.guild_id);
        const userId = String(params.user_id);
        const guild = await client.guilds.fetch(guildId);
        await guild.bans.remove(userId);
        return ok({ unbanned: true, userId, guildId });
      }
      case "role_add": {
        const guildId = String(params.guild_id);
        const userId = String(params.user_id);
        const roleId = String(params.role_id);
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.add(roleId);
        return ok({ roleAdded: true, userId, roleId });
      }
      case "role_remove": {
        const guildId = String(params.guild_id);
        const userId = String(params.user_id);
        const roleId = String(params.role_id);
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.remove(roleId);
        return ok({ roleRemoved: true, userId, roleId });
      }
      case "set_topic": {
        const channelId = String(params.channel_id);
        const topic = String(params.topic);
        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) return err(new Error(`Channel ${channelId} is not a text-based channel`));
        await tc.setTopic(topic);
        return ok({ topicSet: true, channelId, topic });
      }
      case "set_slowmode": {
        const channelId = String(params.channel_id);
        const seconds = Number(params.seconds);
        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) return err(new Error(`Channel ${channelId} is not a text-based channel`));
        await tc.setRateLimitPerUser(seconds);
        return ok({ slowmodeSet: true, channelId, seconds });
      }
      case "guild_info": {
        const guildId = String(params.guild_id);
        const guild = await client.guilds.fetch(guildId);
        return ok({
          id: guild.id,
          name: guild.name,
          memberCount: guild.memberCount,
          ownerId: guild.ownerId,
          // discord.js@14.x types Guild.iconURL() correctly — no cast needed.
          iconURL: guild.iconURL() ?? null,
        });
      }
      case "channel_info": {
        const channelId = String(params.channel_id);
        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) return err(new Error(`Channel ${channelId} is not a text-based channel`));
        // Read-only metadata projection — discord.js@14.x text-like channels
        // (TextChannel, NewsChannel, ThreadChannel, DMChannel) all have `name`
        // on GuildChannel / DMChannel and `topic: string | null` on
        // BaseGuildTextChannel (DMs / forum threads omit topic — handled via
        // the `undefined` check below). The structural projection is local to
        // this site; the canonical DiscordTextLikeChannel contract intentionally
        // omits these read-only metadata fields.
        const ch = tc as DiscordTextLikeChannel & {
          readonly name?: string;
          readonly topic?: string | null;
        };
        const info: Record<string, unknown> = {
          id: ch.id,
          name: ch.name,
          type: ch.type,
        };
        if (ch.topic !== undefined) {
          info.topic = ch.topic;
        }
        return ok(info);
      }
      case "poll": {
        const channelId = String(params.channel_id);
        const question = String(params.question);
        const options = params.options as string[];
        const allowMultiselect =
          params.allow_multiselect === true ||
          (typeof params.max_selections === "number" && params.max_selections > 1);
        const durationHours = normalizePollDurationHours(
          typeof params.duration_hours === "number" ? params.duration_hours : undefined,
        );

        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) {
          return err(new Error("Channel not found or not text-based"));
        }

        const msg = await (channel as TextChannel).send({
          poll: {
            question: { text: question },
            answers: options.map((text) => ({ text })),
            allowMultiselect,
            duration: durationHours,
          },
        });

        return ok({ pollSent: true, messageId: msg.id, channelId });
      }
      // ---------------------------------------------------------------
      // Thread Actions
      // ---------------------------------------------------------------

      case "threadCreate": {
        const channelId = String(params.channel_id);
        const name = String(params.name);
        const messageId = params.message_id ? String(params.message_id) : undefined;
        const autoArchiveDuration =
          typeof params.auto_archive_duration === "number"
            ? params.auto_archive_duration
            : 1440;

        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }
        if (!tc.threads?.create) {
          return err(new Error(`Channel ${channelId} does not support threads`));
        }

        const thread = await tc.threads.create({
          name,
          autoArchiveDuration,
          ...(messageId ? { startMessage: messageId } : {}),
        });

        logger.debug(
          { channelType: "discord", toolName: "discord_action", action: "threadCreate" },
          "Thread created",
        );
        return ok({ threadId: thread.id, name: thread.name });
      }

      case "threadList": {
        const channelId = String(params.channel_id);

        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }
        if (!tc.threads?.fetchActive) {
          return err(new Error(`Channel ${channelId} does not support threads`));
        }

        const fetched = await tc.threads.fetchActive();
        const threads: DiscordThreadInfo[] = [];
        for (const [, t] of fetched.threads) {
          // asThreadInfo() returns null for thread objects with unexpected
          // shape (missing/wrong-typed id/name/archived/memberCount/messageCount).
          // Skip those rather than emitting partial / `?? 0` placeholders —
          // the helper enforces a strict per-field type guard.
          const info = asThreadInfo(t);
          if (!info) continue;
          threads.push(info);
        }

        logger.debug(
          { channelType: "discord", toolName: "discord_action", action: "threadList" },
          "Threads listed",
        );
        return ok({ threads });
      }

      case "threadReply": {
        const threadId = String(params.thread_id);
        const text = String(params.text);

        const channel = await client.channels.fetch(threadId);
        if (!channel || !channel.isThread()) {
          return err(new Error(`Channel ${threadId} is not a thread`));
        }
        // A thread channel is also a text-like channel — asTextLike's runtime
        // isTextBased() check covers thread channels too (discord.js@14.x
        // AnyThreadChannel implements TextBasedChannel).
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${threadId} is not a text-based thread channel`));
        }
        const sent = await tc.send({ content: text });

        logger.debug(
          { channelType: "discord", toolName: "discord_action", action: "threadReply" },
          "Thread reply sent",
        );
        return ok({ messageId: sent.id, threadId });
      }

      // ---------------------------------------------------------------
      // Channel Actions
      // ---------------------------------------------------------------

      case "channelCreate": {
        const guildId = String(params.guild_id);
        const name = String(params.name);
        const typeStr = params.type ? String(params.type) : "text";
        const parentId = params.parent_id ? String(params.parent_id) : undefined;
        const topic = params.topic ? String(params.topic) : undefined;

        // Narrow channel-type keys to discord.js's `GuildChannelTypes` so the
        // `GuildChannelManager.create<Type>` overload resolves to its specific
        // `MappedGuildChannelTypes[Type]` return (rather than the loose
        // non-generic overload that returns `unknown` for arbitrary numeric `type`).
        const channelTypeMap = {
          text: ChannelType.GuildText,
          voice: ChannelType.GuildVoice,
          category: ChannelType.GuildCategory,
          announcement: ChannelType.GuildAnnouncement,
        } as const;
        type SupportedTypeKey = keyof typeof channelTypeMap;
        const mappedType =
          typeStr in channelTypeMap
            ? channelTypeMap[typeStr as SupportedTypeKey]
            : ChannelType.GuildText;

        const guild = await client.guilds.fetch(guildId);
        // discord.js@14.x types guild.channels.create() via GuildChannelManager.
        // The cast narrows the polymorphic union (which can be a partial fetch
        // collection in some code paths) to the manager's create-supporting shape.
        const newChannel = await (guild.channels as GuildChannelManager).create({
          name,
          type: mappedType,
          ...(parentId ? { parent: parentId } : {}),
          ...(topic ? { topic } : {}),
        });

        logger.debug(
          { channelType: "discord", toolName: "discord_action", action: "channelCreate" },
          "Channel created",
        );
        return ok({ channelId: newChannel.id, name: newChannel.name, type: newChannel.type });
      }

      case "channelEdit": {
        const channelId = String(params.channel_id);

        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          return err(new Error(`Channel ${channelId} not found`));
        }
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        const editOptions: Record<string, unknown> = {};
        if (params.name !== undefined) editOptions.name = String(params.name);
        if (params.topic !== undefined) editOptions.topic = String(params.topic);
        if (params.position !== undefined) editOptions.position = Number(params.position);

        await tc.edit(editOptions);

        logger.debug(
          { channelType: "discord", toolName: "discord_action", action: "channelEdit" },
          "Channel edited",
        );
        return ok({ channelId, edited: true });
      }

      case "channelDelete": {
        const channelId = String(params.channel_id);

        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          return err(new Error(`Channel ${channelId} not found`));
        }
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        await tc.delete("Agent-requested channel deletion");

        logger.info(
          { channelType: "discord", action: "channelDelete", chatId: channelId },
          "Channel deleted",
        );
        return ok({ channelId, deleted: true });
      }

      case "channelMove": {
        const channelId = String(params.channel_id);
        const position = Number(params.position);
        const guildId = String(params.guild_id);

        const guild = await client.guilds.fetch(guildId);
        await guild.channels.setPositions([{ channel: channelId, position }]);

        logger.debug(
          { channelType: "discord", toolName: "discord_action", action: "channelMove" },
          "Channel moved",
        );
        return ok({ channelId, position, moved: true });
      }

      // ---------------------------------------------------------------
      // Presence Action
      // ---------------------------------------------------------------

      case "setPresence": {
        const statusText = params.status_text ? String(params.status_text) : undefined;
        const activityTypeStr = params.activity_type ? String(params.activity_type) : "watching";

        const activityMap: Record<string, ActivityType> = {
          playing: ActivityType.Playing,
          watching: ActivityType.Watching,
          listening: ActivityType.Listening,
          competing: ActivityType.Competing,
        };
        const mappedActivity = activityMap[activityTypeStr] ?? ActivityType.Watching;

        client.user?.setPresence({
          activities: statusText ? [{ name: statusText, type: mappedActivity }] : [],
          status: "online",
        });

        logger.debug(
          { channelType: "discord", toolName: "discord_action", action: "setPresence" },
          "Presence updated",
        );
        return ok({ status: "online", activity: statusText, type: activityTypeStr });
      }

      // ---------------------------------------------------------------
      // Deferred Search
      // ---------------------------------------------------------------

      case "searchMessages": {
        return ok({
          deferred: true,
          reason:
            "Discord Bot API does not provide a native message search endpoint. " +
            "Third-party bots implement search via database-backed indexing (e.g., ElasticSearch). " +
            "This feature is deferred until a practical approach is identified.",
        });
      }

      // ---------------------------------------------------------------
      // Typing Indicator
      // ---------------------------------------------------------------

      case "sendTyping": {
        const chatId = String(params.chatId);
        const channel = await client.channels.fetch(chatId);
        const tc = asTextLike(channel);
        if (tc) {
          await tc.sendTyping();
        }
        return ok({ typing: true });
      }

      default: {
        const unsupportedErr = new Error(`Unsupported action: ${action} on discord`);
        logger.warn(
          {
            channelType: "discord",
            err: unsupportedErr,
            hint: `Action '${action}' is not supported by the Discord adapter`,
            errorKind: "validation" as const,
          },
          "Unsupported platform action",
        );
        return err(unsupportedErr);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Discord action '${action}' failed: ${message}`));
  }
}
