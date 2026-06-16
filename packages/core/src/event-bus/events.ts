// SPDX-License-Identifier: Apache-2.0
import type { MessagingEvents } from "./events-messaging.js";
import type { AgentEvents } from "./events-agent.js";
import type { TrajectoryEvents } from "./events-trajectory.js";
import type { ChannelEvents } from "./events-channel.js";
import type { InfraEvents } from "./events-infra.js";
import type { TerminalEvents } from "./events-terminal.js";
import type { MediaGenerationEvents, MediaVisionEvents, MediaVideoGenerationEvents } from "./events-media.js";

/**
 * EventMap: Central type registry for all system events.
 *
 * Composed from domain-grouped sub-interfaces. Find events by subsystem:
 * - MessagingEvents: message, session, compaction, context, response, command
 * - AgentEvents: skill, tool, model, audit, observability (token/latency)
 * - TrajectoryEvents: trajectory-bridge lifecycle (prompt:submitted, session:started/ended/summary, memory:injected, tool:timeout)
 * - ChannelEvents: channel, queue, streaming, typing, autoreply, sendpolicy, debounce, priority, retry, ack
 * - InfraEvents: config, plugin, hook, browser, auth, device, diagnostic, media, scheduler, system, metrics
 * - TerminalEvents: interactive terminal-driver session lifecycle (session_state, spawn_failed)
 * - MediaGenerationEvents: image-generation lifecycle (image:requested/generated/delivered/failed — OBS-04)
 * - MediaVisionEvents: vision-analysis lifecycle (media.vision:requested/completed/failed — VIS-04)
 * - MediaVideoGenerationEvents: video-generation lifecycle (video:requested/submitted/generated/delivered/failed — OBS-04, Phase 192)
 */
export interface EventMap
  extends MessagingEvents,
    AgentEvents,
    TrajectoryEvents,
    ChannelEvents,
    InfraEvents,
    TerminalEvents,
    MediaGenerationEvents,
    MediaVisionEvents,
    MediaVideoGenerationEvents {}
