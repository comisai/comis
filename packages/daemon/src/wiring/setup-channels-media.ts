// SPDX-License-Identifier: Apache-2.0
/**
 * Media pipeline assembly: per-platform resolvers, CompositeResolver,
 * resolveAttachment callback, preprocessMessage callback (link understanding,
 * vision gating, workspace persistence), and audioPreflight callback.
 * Extracted from setup-channels.ts to isolate the media pipeline assembly
 * (~300 lines) into a single-concern module.
 * @module
 */

import { randomUUID } from "node:crypto";
import type { AppContainer, Attachment, ChannelPort, ClockPort, NormalizedMessage, ResolvedTurnScope, SttPreprocessSelection, TranscriptionPort, ImageAnalysisPort, FileExtractionPort, FileExtractionConfig, MemoryPort, VisionDirectPreprocessReceipt, WrapExternalContentOptions, MediaAttachmentPreprocessReceipt, MediaResolutionError } from "@comis/core";
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
  type MsTeamsPluginHandle,
  type PreflightResult,
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
import { getModel } from "@earendil-works/pi-ai/compat";
import { formatMediaAttachmentRejection, MEDIA_ATTACHMENT_PREPROCESS_RECEIPT_MAX, MEDIA_REMOTE_FETCH_LIMIT_CONFIG_KEY, MediaAttachmentPreprocessReceiptSchema, MediaAttachmentPreprocessReceiptsSchema, MediaResolutionError as StructuredMediaResolutionError, safePath, SttPreprocessReceiptsSchema, systemNowMs } from "@comis/core";
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
  preprocessMessage: (
    msg: NormalizedMessage,
    turnScope: ResolvedTurnScope,
  ) => Promise<NormalizedMessage>;
  /** Audio preflight for voice note transcription (undefined when no transcriber). */
  audioPreflight?: (msg: NormalizedMessage) => Promise<PreflightResult>;
}

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Dependencies for media pipeline assembly. */
export interface MediaPipelineDeps {
  container: AppContainer;
  clock: ClockPort;
  channelsLogger: ComisLogger;
  adaptersByType: Map<string, ChannelPort>;
  tgPlugin?: TelegramPluginHandle;
  linePlugin?: LinePluginHandle;
  msTeamsPlugin?: MsTeamsPluginHandle;
  ssrfFetcher: SsrfGuardedFetcher;
  linkRunner: LinkRunner;
  transcriber?: TranscriptionPort;
  /** Boot-resolved provider selection paired with the transcriber. */
  voiceSelection?: {
    stt?: Omit<SttPreprocessSelection, "model">;
  };
  maxMediaBytes: number;
  defaultAgentId: string;
  imageAnalyzer?: ImageAnalysisPort;
  fileExtractor?: FileExtractionPort;
  fileExtractionConfig?: FileExtractionConfig;
  workspaceDirs?: Map<string, string>;
  memoryAdapter?: MemoryPort;
  tenantId?: string;
  embeddingQueue?: { enqueue(id: string, content: string): void };
  /** Optional callback for suspicious-content detection in media textPrefix wrap output.
   *  Threaded through to preprocessMessage's deps so audio/image/video handlers fire the callback
   *  when wrapExternalContent detects injection patterns. */
  onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"] | undefined;
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
    msTeamsPlugin,
    ssrfFetcher,
    linkRunner,
    transcriber,
    maxMediaBytes,
    onSuspiciousContent,
  } = deps;
  const transcriptionConfig = container.config.integrations.media.transcription;
  const sttSelection: SttPreprocessSelection | undefined =
    deps.voiceSelection?.stt === undefined
      ? undefined
      : {
          ...deps.voiceSelection.stt,
          ...(deps.voiceSelection.stt.provider === "local"
            ? { model: transcriptionConfig.local?.model ?? "base" }
            : transcriptionConfig.model !== undefined
              ? { model: transcriptionConfig.model }
              : {}),
        };

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

  const agents = container.config.agents;

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

  // Microsoft Teams: resolver created from plugin handle (closes over the
  // Connector-token getter). The SAME injected auth-capable ssrfFetcher + the
  // config allowlist (the resolver applies its built-in default when empty) —
  // never a bare fetch or an over-broad list.
  if (msTeamsPlugin) {
    platformResolvers.push(
      msTeamsPlugin.createResolver({
        ssrfFetcher,
        maxBytes: maxMediaBytes,
        logger: channelsLogger,
        mediaAuthAllowHosts: channelConfig?.msteams?.mediaAuthAllowHosts ?? [],
      }),
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
  const resolveAttachmentWithReceipt = async (
    att: Attachment,
    onRejection?: (error: MediaResolutionError) => void,
  ): Promise<Buffer | null> => {
    const startedAt = systemNowMs();
    const result = await compositeResolver.resolve(att);
    if (!result.ok) {
      const durationMs = systemNowMs() - startedAt;
      if (result.error instanceof StructuredMediaResolutionError) {
        onRejection?.(result.error);
        channelsLogger.warn(
          {
            sizeBytes: result.error.sizeBytes,
            maxBytes: result.error.maxBytes,
            configKey: MEDIA_REMOTE_FETCH_LIMIT_CONFIG_KEY,
            durationMs,
            hint: `Send an attachment no larger than ${result.error.maxBytes} bytes or raise ${MEDIA_REMOTE_FETCH_LIMIT_CONFIG_KEY} above ${result.error.sizeBytes}`,
            errorKind: "precondition" as const,
          },
          "Media attachment rejected by size limit",
        );
        return null;
      }
      channelsLogger.warn(
        { url: att.url, err: result.error.message, durationMs, hint: "Check the channel media resolver, platform credentials, and network connectivity", errorKind: "network" as const },
        "Media resolution failed",
      );
      return null;
    }
    return result.value.buffer;
  };
  const resolveAttachment = (att: Attachment): Promise<Buffer | null> =>
    resolveAttachmentWithReceipt(att);

  // Build preprocessMessage callback (wraps link understanding + media resolution)
  const preprocessMessageCallback = async (
    msg: NormalizedMessage,
    turnScope: ResolvedTurnScope,
  ): Promise<NormalizedMessage> => {
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
      if (linkResult.receipt !== undefined) {
        enrichedMsg = {
          ...enrichedMsg,
          metadata: {
            ...enrichedMsg.metadata,
            linkPrefetch: linkResult.receipt,
          },
        };
      }
    }

    // 2. Media preprocessing with vision gating
    if (enrichedMsg.attachments && enrichedMsg.attachments.length > 0) {
      const attachmentReceiptsByIndex = new Map<number, MediaAttachmentPreprocessReceipt>();
      const resolveCurrentAttachment = (att: Attachment): Promise<Buffer | null> =>
        resolveAttachmentWithReceipt(att, (error) => {
          const attachmentIndex = enrichedMsg.attachments?.indexOf(att) ?? -1;
          if (
            attachmentIndex < 0
            || attachmentIndex >= MEDIA_ATTACHMENT_PREPROCESS_RECEIPT_MAX
          ) return;
          attachmentReceiptsByIndex.set(attachmentIndex, {
            attachmentIndex,
            outcome: "rejected",
            reason: error.kind,
            sizeBytes: error.sizeBytes,
            maxBytes: error.maxBytes,
            configKey: MEDIA_REMOTE_FETCH_LIMIT_CONFIG_KEY,
          });
        });
      const hasImages = enrichedMsg.attachments.some(
        (a) => a.type === "image" || a.mimeType?.startsWith("image/"),
      );

      // Vision gating: use native image content blocks when model supports vision,
      // fall back to text-description via imageAnalyzer when it does not.
      // Automatic analysis requires both the global vision switch and the
      // per-channel analyzeImages switch. On-demand vision tools are wired
      // separately and remain available when automatic processing is off.
      const imagesEnabled = visionConfig.enabled
        && channelMediaConfig?.analyzeImages !== false;
      const agentConfig = agents[turnScope.conversation.agentId];
      let agentModelVisionCapable = false;
      if (agentConfig !== undefined) {
        try {
          /* eslint-disable @typescript-eslint/no-explicit-any -- pi-ai getModel requires KnownProvider/KnownModel, config stores flexible strings */
          const resolvedModel = getModel(
            agentConfig.provider as any,
            agentConfig.model as any,
          );
          /* eslint-enable @typescript-eslint/no-explicit-any */
          if (resolvedModel) {
            agentModelVisionCapable = isVisionCapable(resolvedModel);
          }
        } catch {
          channelsLogger.debug(
            { agentId: turnScope.conversation.agentId },
            "Model resolution for vision check failed",
          );
        }
      }
      const visionAvailable = hasImages
        && agentModelVisionCapable
        && imagesEnabled;
      const visionPreprocess: VisionDirectPreprocessReceipt | undefined =
        visionAvailable && agentConfig !== undefined
          ? {
              provider: agentConfig.provider,
              mainProvider: agentConfig.provider,
              model: agentConfig.model,
              path: "vision-direct",
              outcome: "ok",
            }
          : undefined;

      // Wrap resolveAttachment to intercept buffers for workspace persistence
      const persistedFiles: PersistedFile[] = [];
      const persistedFilePaths = new Map<string, string>();
      const persistenceResolutions = new Map<string, Promise<Buffer | null>>();
      const effectiveResolve = persistenceEnabled
        ? (att: Attachment): Promise<Buffer | null> => {
          const existing = persistenceResolutions.get(att.url);
          if (existing) return existing;
          const pending = (async () => {
            const buffer = await resolveCurrentAttachment(att);
            if (buffer) {
              // Classify attachment for subdirectory routing
              const mediaKind = att.mimeType?.startsWith("image/") || att.type === "image" ? "image"
                : att.mimeType?.startsWith("video/") || att.type === "video" ? "video"
                : att.mimeType?.startsWith("audio/") || att.type === "audio" ? "audio"
                : "document";

              const agentId = turnScope.conversation.agentId;
              const svc = agentPersistenceServices.get(agentId);

              if (svc) {
                try {
                  const persistResult = await svc.persist(buffer, {
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                    mediaKind: mediaKind as "image" | "video" | "audio" | "document",
                  });
                  if (persistResult.ok) {
                    persistedFiles.push(persistResult.value);
                    persistedFilePaths.set(att.url, persistResult.value.relativePath);
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
          })();
          persistenceResolutions.set(att.url, pending);
          return pending;
        }
        : resolveCurrentAttachment;

      if (persistenceEnabled) {
        for (const attachment of enrichedMsg.attachments) {
          if (attachment.sizeBytes !== undefined && attachment.sizeBytes > maxMediaBytes) continue;
          await effectiveResolve(attachment);
        }
      }

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
          sttSelection: container.config.integrations.media.transcription.autoTranscribe && audioEnabled
            ? sttSelection
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
          onSuspiciousContent,
        },
        enrichedMsg,
        {
          durableFilePath: (attachment) => persistedFilePaths.get(attachment.url),
        },
      );
      const sttReceipts = SttPreprocessReceiptsSchema.safeParse(
        result.sttReceipts,
      );
      const combinedAttachmentReceipts = [
        ...(result.attachmentReceipts ?? []),
        ...attachmentReceiptsByIndex.values(),
      ].filter((receipt, index, all) =>
        all.findIndex((candidate) =>
          candidate.attachmentIndex === receipt.attachmentIndex
          && candidate.reason === receipt.reason,
        ) === index,
      );
      // Validate receipt by receipt. A coalesced turn can carry more attachments than
      // one receipt can address, and parsing the batch as a unit dropped every valid
      // receipt alongside the one out-of-range entry — losing the trajectory records
      // and the incident signal for rejections that were correctly observed.
      const trustedAttachmentReceipts = combinedAttachmentReceipts.filter(
        (receipt) => MediaAttachmentPreprocessReceiptSchema.safeParse(receipt).success,
      );
      const droppedAttachmentReceiptCount =
        combinedAttachmentReceipts.length - trustedAttachmentReceipts.length
        + Math.max(
          0,
          trustedAttachmentReceipts.length - MEDIA_ATTACHMENT_PREPROCESS_RECEIPT_MAX,
        );
      if (droppedAttachmentReceiptCount > 0) {
        channelsLogger.warn({
          droppedAttachmentReceiptCount,
          trustedAttachmentReceiptCount: Math.min(
            trustedAttachmentReceipts.length,
            MEDIA_ATTACHMENT_PREPROCESS_RECEIPT_MAX,
          ),
          errorKind: "validation" as const,
          hint: `Attachment rejection evidence is bounded to the first ${MEDIA_ATTACHMENT_PREPROCESS_RECEIPT_MAX} attachments of a turn; rejections beyond that bound reach the model as prose only`,
        }, "Attachment rejection receipts dropped before turn metadata");
      }
      const attachmentReceipts = MediaAttachmentPreprocessReceiptsSchema.safeParse(
        trustedAttachmentReceipts.slice(0, MEDIA_ATTACHMENT_PREPROCESS_RECEIPT_MAX),
      );
      const missingNotices = attachmentReceipts.success
        ? attachmentReceipts.data
            .map(formatMediaAttachmentRejection)
            .filter((notice) => !result.message.text.includes(notice))
        : [];
      const resultMessage = {
        ...result.message,
        text: missingNotices.length > 0
          ? `${missingNotices.join("\n")}\n\n${result.message.text}`
          : result.message.text,
        metadata: {
          ...result.message.metadata,
          ...(sttReceipts.success && sttReceipts.data.length > 0
            ? { sttPreprocess: sttReceipts.data }
            : {}),
          ...(attachmentReceipts.success && attachmentReceipts.data.length > 0
            ? { mediaAttachmentPreprocess: attachmentReceipts.data }
            : {}),
        },
      };

      // Emit file extraction events
      for (const fe of result.fileExtractions) {
        container.eventBus.emit("media:file_extracted", {
          fileName: fe.fileName,
          mimeType: fe.mimeType,
          chars: fe.extractedChars,
          truncated: fe.truncated,
          durationMs: fe.durationMs,
          timestamp: systemNowMs(),
        });
      }

      // Store memory entries linking persisted files to text descriptions
      const memoryTurnScope = turnScope;
      if (persistedFiles.length > 0 && deps.memoryAdapter) {
        const agentId = memoryTurnScope.conversation.agentId;

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
              content,
              trustLevel: "learned",
              source: { who: senderInfo, channel: channelType },
              tags: ["media-file", pf.mediaKind],
              createdAt: systemNowMs(),
            }, {
              turnScope: memoryTurnScope,
              visibility: { kind: "conversation" },
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
            timestamp: systemNowMs(),
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
            ...resultMessage.metadata,
            imageContents: result.imageContents,
            ...(visionPreprocess !== undefined
              ? { visionPreprocess }
              : {}),
          },
        };
      }

      return resultMessage;
    }

    return enrichedMsg;
  };

  // Build audioPreflight callback (wraps transcriber + resolveAttachment)
  const configuredBotNames = Object.values(container.config.agents)
    .map((a) => a.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  const preflightFn = transcriber && transcriptionConfig.preflight
    ? async (msg: NormalizedMessage) => {
        const botNames = [
          ...configuredBotNames,
          ...(msg.channelType === "telegram"
            ? tgPlugin?.getBotMentionNames() ?? []
            : []),
        ];
        return audioPreflight(
          {
            transcriber,
            resolveAttachment,
            botNames,
            clock: deps.clock,
            sttSelection,
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
