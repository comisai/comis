/**
 * Media pipeline assembly: per-platform resolvers, CompositeResolver,
 * resolveAttachment callback, preprocessMessage callback (link understanding,
 * vision gating, workspace persistence), and audioPreflight callback.
 * Extracted from setup-channels.ts to isolate the media pipeline assembly
 * (~300 lines) into a single-concern module.
 * @module
 */

import { randomUUID } from "node:crypto";
import type { AppContainer, Attachment, ChannelPort, NormalizedMessage, TranscriptionPort, ImageAnalysisPort, FileExtractionPort, FileExtractionConfig, MemoryPort } from "@comis/core";
import type { MediaResolverPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { isVisionCapable } from "@comis/agent";
import {
  createWhatsAppResolver,
  createSlackResolver,
  createIMessageResolver,
  audioPreflight,
  type WhatsAppAdapterHandle,
  type TelegramPluginHandle,
  type LinePluginHandle,
} from "@comis/channels";
import {
  createCompositeResolver,
  createMediaPersistenceService,
  preprocessMessage,
  sanitizeImageForApi,
  createVisionProviderRegistry,
  selectVisionProvider,
  type SsrfGuardedFetcher,
} from "@comis/skills";
import type { LinkRunner, MediaPersistenceService, PersistedFile } from "@comis/skills";
import { getModel } from "@mariozechner/pi-ai";
import { safePath } from "@comis/core";
import os from "node:os";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Output of the media pipeline assembly. */
export interface MediaPipelineResult {
  /** Composite media resolver routing to per-platform resolvers. */
  compositeResolver: MediaResolverPort;
  /** Attachment resolver callback (Attachment -> Buffer|null). */
  resolveAttachment: (att: Attachment) => Promise<Buffer | null>;
  /** Message preprocessor: link understanding + media resolution + persistence. */
  preprocessMessage: (msg: NormalizedMessage) => Promise<NormalizedMessage>;
  /** Audio preflight for voice note transcription (undefined when no transcriber). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PreflightResult type from channels package not re-exported
  audioPreflight?: (msg: NormalizedMessage) => Promise<any>;
}

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Dependencies for media pipeline assembly. */
export interface MediaPipelineDeps {
  container: AppContainer;
  channelsLogger: ComisLogger;
  adaptersByType: Map<string, ChannelPort>;
  tgPlugin?: TelegramPluginHandle;
  linePlugin?: LinePluginHandle;
  ssrfFetcher: SsrfGuardedFetcher;
  linkRunner: LinkRunner;
  transcriber?: TranscriptionPort;
  maxMediaBytes: number;
  defaultAgentId: string;
  imageAnalyzer?: ImageAnalysisPort;
  fileExtractor?: FileExtractionPort;
  fileExtractionConfig?: FileExtractionConfig;
  workspaceDirs?: Map<string, string>;
  memoryAdapter?: MemoryPort;
  tenantId?: string;
  embeddingQueue?: { enqueue(id: string, content: string): void };
}

// ---------------------------------------------------------------------------
// Build function
// ---------------------------------------------------------------------------

/**
 * Assemble the complete media pipeline: per-platform resolvers,
 * CompositeResolver, resolveAttachment, preprocessMessage, and audioPreflight.
 * @param deps - Media pipeline dependencies
 * @returns Composite resolver, attachment resolver, message preprocessor, audio preflight
 */
export async function buildMediaPipeline(deps: MediaPipelineDeps): Promise<MediaPipelineResult> {
  const {
    container,
    channelsLogger,
    adaptersByType,
    tgPlugin,
    linePlugin,
    ssrfFetcher,
    linkRunner,
    transcriber,
    maxMediaBytes,
    defaultAgentId,
  } = deps;

  // -- Media file persistence --
  const persistenceConfig = container.config.integrations.media.persistence;
  const persistenceEnabled = persistenceConfig.enabled && !!deps.workspaceDirs;

  // Create per-agent persistence services (each agent saves to its own workspace)
  const agentPersistenceServices = new Map<string, MediaPersistenceService>();
  if (persistenceEnabled && deps.workspaceDirs) {
    for (const [agentId, wsDir] of deps.workspaceDirs) {
      agentPersistenceServices.set(agentId, createMediaPersistenceService({
        workspaceDir: wsDir,
        logger: channelsLogger,
        maxBytes: persistenceConfig.maxFileBytes,
      }));
    }
    channelsLogger.info(
      { agentCount: agentPersistenceServices.size },
      "Media file persistence enabled",
    );
  }

  // Determine if the default agent's model supports vision input.
  const agents = container.config.agents;
  const defaultAgentConfig = Object.values(agents)[0];
  let defaultModelVisionCapable = false;
  if (defaultAgentConfig) {
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any -- pi-ai getModel requires KnownProvider/KnownModel, config stores flexible strings */
      const resolvedModel = getModel(
        defaultAgentConfig.provider as any,
        defaultAgentConfig.model as any,
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (resolvedModel) {
        defaultModelVisionCapable = isVisionCapable(resolvedModel);
      }
    } catch {
      // Model resolution failed -- assume no vision, use text-description fallback
      channelsLogger.debug("Model resolution for vision check failed, defaulting to text-description path");
    }
  }
  channelsLogger.debug({ defaultModelVisionCapable }, "Vision capability check complete");

  // Build video description callback from VisionProvider registry
  const visionConfig = container.config.integrations.media.vision;
  let describeVideoCallback: ((video: Buffer, mimeType: string, prompt: string) => Promise<import("@comis/shared").Result<{ text: string; provider: string; model: string }, Error>>) | undefined;

  if (visionConfig.enabled) {
    const visionRegistry = createVisionProviderRegistry({
      secretManager: container.secretManager,
      config: visionConfig,
    });
    const videoProvider = selectVisionProvider(visionRegistry, "video");
    if (videoProvider?.describeVideo) {
      const videoTimeoutMs = visionConfig.videoTimeoutMs;
      const maxDescChars = visionConfig.videoMaxDescriptionChars;
      describeVideoCallback = async (video, mimeType, prompt) => {
        return videoProvider.describeVideo!({
          video,
          prompt,
          mimeType,
        });
      };
      channelsLogger.debug({ provider: videoProvider.id, videoTimeoutMs, maxDescChars }, "Video description callback wired");
    } else {
      channelsLogger.debug("No video-capable vision provider found, video description disabled");
    }
  }

  // Helper: attempt to get a secret, return undefined if not found
  const getSecret = (name: string): string | undefined => {
    try { return container.secretManager.get(name); } catch { return undefined; }
  };

  const channelConfig = container.config.channels;

  // Build per-platform resolvers for platforms that have adapters.
  // Discord and Signal resolvers are NOT registered by scheme. Their HTTPS
  // URLs go through the SSRF fallback.
  const platformResolvers: MediaResolverPort[] = [];

  const whatsappAdapter = adaptersByType.get("whatsapp") as (ChannelPort & WhatsAppAdapterHandle) | undefined;
  if (whatsappAdapter && "getRawMessage" in whatsappAdapter) {
    platformResolvers.push(
      createWhatsAppResolver({
        getRawMessage: (id: string) => whatsappAdapter.getRawMessage(id),
        maxBytes: maxMediaBytes,
        logger: channelsLogger,
      }),
    );
  }

  const slackToken = (channelConfig?.slack.botToken as string | undefined) || getSecret("SLACK_BOT_TOKEN");
  if (adaptersByType.has("slack") && slackToken) {
    platformResolvers.push(
      createSlackResolver({ botToken: slackToken, maxBytes: maxMediaBytes, logger: channelsLogger }),
    );
  }

  if (adaptersByType.has("imessage")) {
    platformResolvers.push(
      createIMessageResolver({
        allowedBasePaths: [safePath(safePath(safePath(os.homedir(), "Library"), "Messages"), "Attachments")],
        maxBytes: maxMediaBytes,
        logger: channelsLogger,
      }),
    );
  }

  // Telegram: resolver created from plugin handle (exposes Grammy Bot + botToken via closure)
  if (tgPlugin) {
    platformResolvers.push(
      tgPlugin.createResolver({ ssrfFetcher, maxBytes: maxMediaBytes, logger: channelsLogger }),
    );
  }

  // LINE: resolver created from plugin handle (exposes BlobClient via closure)
  if (linePlugin) {
    platformResolvers.push(
      linePlugin.createResolver({ maxBytes: maxMediaBytes, logger: channelsLogger }),
    );
  }

  // Create CompositeResolver with all per-platform resolvers + SSRF fallback
  const compositeResolver = createCompositeResolver({
    resolvers: platformResolvers,
    ssrfFetcher,
    maxBytes: maxMediaBytes,
    logger: channelsLogger,
  });

  channelsLogger.debug({
    resolverCount: platformResolvers.length,
    schemes: compositeResolver.schemes,
  }, "CompositeResolver initialized");

  // Resolve attachment callback for media preprocessor and preflight
  const resolveAttachment = async (att: Attachment): Promise<Buffer | null> => {
    const result = await compositeResolver.resolve(att);
    if (!result.ok) {
      channelsLogger.warn(
        { url: att.url, err: result.error.message, hint: "Check platform resolver and network connectivity", errorKind: "network" as const },
        "Media resolution failed",
      );
      return null;
    }
    return result.value.buffer;
  };

  // Build preprocessMessage callback (wraps link understanding + media resolution)
  const preprocessMessageCallback = async (msg: NormalizedMessage): Promise<NormalizedMessage> => {
    // Per-channel media processing config (all default to true when absent)
    // Exclude healthCheck key from lookup -- it's not a channel adapter entry
    const channelEntry = msg.channelType !== "healthCheck"
      ? container.config.channels[msg.channelType as Exclude<keyof typeof container.config.channels, "healthCheck">]
      : undefined;
    const channelMediaConfig = channelEntry && "mediaProcessing" in channelEntry ? channelEntry.mediaProcessing : undefined;

    // 1. Link understanding (enrich text with link content)
    let enrichedMsg = msg;
    if (msg.text && linkRunner && channelMediaConfig?.understandLinks !== false) {
      const linkResult = await linkRunner.processMessage(msg.text);
      if (linkResult.enrichedText !== msg.text) {
        enrichedMsg = { ...msg, text: linkResult.enrichedText };
      }
    }

    // 2. Media preprocessing with vision gating
    if (enrichedMsg.attachments && enrichedMsg.attachments.length > 0) {
      const hasImages = enrichedMsg.attachments.some(
        (a) => a.type === "image" || a.mimeType?.startsWith("image/"),
      );

      // Vision gating: use native image content blocks when model supports vision,
      // fall back to text-description via imageAnalyzer when it does not.
      // Also respect per-channel analyzeImages toggle.
      const imagesEnabled = channelMediaConfig?.analyzeImages !== false;
      const visionAvailable = hasImages && defaultModelVisionCapable && imagesEnabled;

      // Wrap resolveAttachment to intercept buffers for workspace persistence
      const persistedFiles: PersistedFile[] = [];
      const effectiveResolve = persistenceEnabled
        ? async (att: Attachment) => {
            const buffer = await resolveAttachment(att);
            if (buffer) {
              // Classify attachment for subdirectory routing
              const mediaKind = att.mimeType?.startsWith("image/") || att.type === "image" ? "image"
                : att.mimeType?.startsWith("video/") || att.type === "video" ? "video"
                : att.mimeType?.startsWith("audio/") || att.type === "audio" ? "audio"
                : "document";

              // Determine which agent's workspace to use
              const agentId = (enrichedMsg.metadata?._agentId as string | undefined) ?? defaultAgentId;
              const svc = agentPersistenceServices.get(agentId)
                ?? agentPersistenceServices.get(defaultAgentId);

              if (svc) {
                try {
                  const persistResult = await svc.persist(buffer, {
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                    mediaKind: mediaKind as "image" | "video" | "audio" | "document",
                  });
                  if (persistResult.ok) {
                    persistedFiles.push(persistResult.value);
                    channelsLogger.info(
                      { relativePath: persistResult.value.relativePath, sizeBytes: persistResult.value.sizeBytes, mediaKind },
                      "Media file persisted to workspace",
                    );
                  } else {
                    channelsLogger.warn(
                      { err: persistResult.error.message, mediaKind, hint: "File persistence failed; message processing continues", errorKind: "resource" as const },
                      "Media file persistence failed",
                    );
                  }
                } catch (e) {
                  channelsLogger.warn(
                    { err: e instanceof Error ? e.message : String(e), mediaKind, hint: "File persistence threw; message processing continues", errorKind: "resource" as const },
                    "Media file persistence error",
                  );
                }
              }
            }
            return buffer;
          }
        : resolveAttachment;

      // Per-channel processor gating: disable processors when channel config says false
      const audioEnabled = channelMediaConfig?.transcribeAudio !== false;
      const videosEnabled = channelMediaConfig?.describeVideos !== false;
      const documentsEnabled = channelMediaConfig?.extractDocuments !== false;

      const result = await preprocessMessage(
        {
          // Gate auto-transcription on global config + per-channel toggle
          transcriber: container.config.integrations.media.transcription.autoTranscribe && audioEnabled
            ? transcriber
            : undefined,
          // Pass imageAnalyzer ONLY when vision is NOT available AND images are enabled
          imageAnalyzer: visionAvailable ? undefined : (imagesEnabled ? deps.imageAnalyzer : undefined),
          resolveAttachment: effectiveResolve,
          maxMediaBytes,
          logger: channelsLogger,
          // Vision-direct path: sanitize images for API injection
          visionAvailable,
          sanitizeImage: visionAvailable ? async (buffer: Buffer, mimeType: string) => {
            return sanitizeImageForApi(buffer, mimeType);
          } : undefined,
          // Video description via Gemini (or other video-capable provider) — gated per channel
          describeVideo: videosEnabled ? describeVideoCallback : undefined,
          maxVideoDescriptionChars: visionConfig.videoMaxDescriptionChars,
          // Document extraction pipeline — gated per channel
          fileExtractor: documentsEnabled ? deps.fileExtractor : undefined,
          fileExtractionConfig: deps.fileExtractionConfig ? {
            maxTotalChars: deps.fileExtractionConfig.maxTotalChars,
          } : undefined,
        },
        enrichedMsg,
      );

      // Emit file extraction events
      for (const fe of result.fileExtractions) {
        container.eventBus.emit("media:file_extracted", {
          fileName: fe.fileName,
          mimeType: fe.mimeType,
          chars: fe.extractedChars,
          truncated: fe.truncated,
          durationMs: fe.durationMs,
          timestamp: Date.now(),
        });
      }

      // Store memory entries linking persisted files to text descriptions
      if (persistedFiles.length > 0 && deps.memoryAdapter) {
        const agentId = (enrichedMsg.metadata?._agentId as string | undefined) ?? defaultAgentId;
        const tenantId = deps.tenantId ?? "default";

        for (const pf of persistedFiles) {
          const kindLabel = pf.mediaKind === "image" ? "Photo"
            : pf.mediaKind === "video" ? "Video"
            : pf.mediaKind === "audio" ? "Audio"
            : "Document";

          // Build concise memory content with file path at the START (survives truncation)
          const senderInfo = enrichedMsg.senderId ?? "unknown";
          const channelType = enrichedMsg.channelType ?? "unknown";
          const content = `File: ${pf.relativePath} | [${kindLabel} received] From: ${senderInfo} via ${channelType}`;

          const entryId = randomUUID();
          try {
            const storeResult = await deps.memoryAdapter.store({
              id: entryId,
              tenantId,
              agentId,
              userId: senderInfo,
              content,
              trustLevel: "learned",
              source: { who: senderInfo, channel: channelType },
              tags: ["media-file", pf.mediaKind],
              createdAt: Date.now(),
            });
            if (storeResult.ok && deps.embeddingQueue) {
              deps.embeddingQueue.enqueue(entryId, content);
            }
            if (!storeResult.ok) {
              channelsLogger.warn(
                { err: storeResult.error.message, relativePath: pf.relativePath, hint: "Memory store failed for persisted file", errorKind: "resource" as const },
                "Media memory entry store failed",
              );
            }
          } catch (e) {
            channelsLogger.warn(
              { err: e instanceof Error ? e.message : String(e), relativePath: pf.relativePath, hint: "Memory store threw for persisted file", errorKind: "resource" as const },
              "Media memory entry store error",
            );
          }

          // Emit event regardless of memory store success
          container.eventBus.emit("media:file_persisted", {
            relativePath: pf.relativePath,
            mimeType: pf.mimeType,
            sizeBytes: pf.sizeBytes,
            mediaKind: pf.mediaKind,
            agentId,
            timestamp: Date.now(),
          });
        }

        channelsLogger.debug?.(
          { count: persistedFiles.length, paths: persistedFiles.map(f => f.relativePath) },
          "Media persistence batch complete",
        );
      }

      // Inject imageContents into message metadata for executor consumption
      if (result.imageContents && result.imageContents.length > 0) {
        channelsLogger.debug(
          { imageContentCount: result.imageContents.length },
          "Vision-direct imageContents injected into message metadata",
        );
        return {
          ...result.message,
          metadata: {
            ...result.message.metadata,
            imageContents: result.imageContents,
          },
        };
      }

      return result.message;
    }

    return enrichedMsg;
  };

  // Build audioPreflight callback (wraps transcriber + resolveAttachment)
  const botNames = Object.values(container.config.agents)
    .map((a) => a.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  const preflightFn = transcriber
    ? async (msg: NormalizedMessage) => {
        return audioPreflight(
          {
            transcriber,
            resolveAttachment,
            botNames,
            logger: channelsLogger,
          },
          msg,
        );
      }
    : undefined;

  return {
    compositeResolver,
    resolveAttachment,
    preprocessMessage: preprocessMessageCallback,
    audioPreflight: preflightFn,
  };
}
