import type { MessagingEvents } from "./events-messaging.js";
import type { AgentEvents } from "./events-agent.js";
import type { ChannelEvents } from "./events-channel.js";
import type { InfraEvents } from "./events-infra.js";

/**
 * EventMap: Central type registry for all system events.
 *
 * Composed from domain-grouped sub-interfaces. Find events by subsystem:
 * - MessagingEvents: message, session, compaction, context, response, command
 * - AgentEvents: skill, tool, model, audit, observability (token/latency)
 * - ChannelEvents: channel, queue, streaming, typing, autoreply, sendpolicy, debounce, priority, retry, ack
 * - InfraEvents: config, plugin, hook, browser, auth, device, diagnostic, media, scheduler, system, metrics
 */
export interface EventMap extends MessagingEvents, AgentEvents, ChannelEvents, InfraEvents {}
