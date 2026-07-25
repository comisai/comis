// SPDX-License-Identifier: Apache-2.0
/** Owner-validated graph report attachment delivery. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import type { ChannelPort, ClockPort, ComisLogger, DeliverToChannelOptions, DeliveryService, OutwardSendLedgerPort, RootRunIdResolver, SessionKey } from "@comis/core";
import { ChannelEndpointSchema, ConversationRefSchema, formatSessionKey, safePath, sanitizeLogString } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { wrapOutwardSend } from "../../api/outward-ledger-wrap.js";

const GRAPH_ID_RE = /^[a-f0-9-]{8,64}$/i;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 25 * 1024 * 1024;
const SNAPSHOT_DIR = "graph-report-deliveries";

interface ExpectedFileIdentity {
  dev: number;
  ino: number;
  size: number;
}

async function closeFile(handle: FileHandle): Promise<Result<void, Error>> {
  return fromPromise(handle.close());
}

async function readPinnedRegularFile(
  path: string,
  expected: ExpectedFileIdentity,
  maxBytes: number,
): Promise<Result<Buffer, Error>> {
  const opened = await fromPromise(open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) return opened;
  const handle = opened.value;
  const fileStat = await fromPromise(handle.stat());
  if (!fileStat.ok) {
    await closeFile(handle);
    return fileStat;
  }
  if (
    !fileStat.value.isFile()
    || fileStat.value.nlink !== 1
    || fileStat.value.dev !== expected.dev
    || fileStat.value.ino !== expected.ino
    || fileStat.value.size !== expected.size
    || fileStat.value.size > maxBytes
  ) {
    await closeFile(handle);
    return err(new Error("Report source changed or is not a bounded regular file"));
  }

  const content = Buffer.alloc(fileStat.value.size);
  let offset = 0;
  while (offset < content.length) {
    const read = await fromPromise(handle.read(content, offset, content.length - offset, offset));
    if (!read.ok) {
      await closeFile(handle);
      return read;
    }
    if (read.value.bytesRead === 0) {
      await closeFile(handle);
      return err(new Error("Report source changed while it was being snapshotted"));
    }
    offset += read.value.bytesRead;
  }

  const finalStat = await fromPromise(handle.stat());
  const closed = await closeFile(handle);
  if (!finalStat.ok) return finalStat;
  if (!closed.ok) return closed;
  if (finalStat.value.size !== expected.size) {
    return err(new Error("Report source size changed while it was being snapshotted"));
  }
  return ok(content);
}

async function writeOwnerOnlySnapshot(
  dataDir: string,
  content: Buffer,
): Promise<Result<string, Error>> {
  const snapshotDirResult = tryCatch(() => safePath(dataDir, SNAPSHOT_DIR));
  if (!snapshotDirResult.ok) return snapshotDirResult;
  const snapshotDir = snapshotDirResult.value;
  const createdDir = await fromPromise(mkdir(snapshotDir, { recursive: true, mode: 0o700 }));
  if (!createdDir.ok) return createdDir;
  const directoryStat = await fromPromise(lstat(snapshotDir));
  if (
    !directoryStat.ok
    || !directoryStat.value.isDirectory()
    || directoryStat.value.isSymbolicLink()
    || (directoryStat.value.mode & 0o077) !== 0
  ) {
    return err(new Error("Graph report snapshot directory is not owner-only"));
  }

  const snapshotPathResult = tryCatch(() => safePath(snapshotDir, `${randomUUID()}.md`));
  if (!snapshotPathResult.ok) return snapshotPathResult;
  const snapshotPath = snapshotPathResult.value;
  const opened = await fromPromise(open(
    snapshotPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  ));
  if (!opened.ok) return opened;
  const handle = opened.value;
  // fs-safe-allowed: the exclusive no-follow handle was opened owner-read-only above and must be synced before exposure.
  const written = await fromPromise(handle.writeFile(content));
  if (!written.ok) {
    await closeFile(handle);
    await fromPromise(unlink(snapshotPath));
    return written;
  }
  const synced = await fromPromise(handle.sync());
  const closed = await closeFile(handle);
  if (!synced.ok) {
    await fromPromise(unlink(snapshotPath));
    return synced;
  }
  if (!closed.ok) {
    await fromPromise(unlink(snapshotPath));
    return closed;
  }
  return ok(snapshotPath);
}

export interface GraphReportDeliveryDeps {
  dataDir: string;
  clock: ClockPort;
  logger: ComisLogger;
  deliveryService: DeliveryService;
  durability: GraphReportDurability;
}

export interface GraphReportDurability {
  outwardLedger: OutwardSendLedgerPort | undefined;
  resolveRootRunId: RootRunIdResolver | undefined;
}

export type GraphReportRequestHandler = (
  graphId: string,
  channelType: string,
  channelId: string,
  adapter: ChannelPort,
  options: DeliverToChannelOptions,
  sessionKey: SessionKey,
) => Promise<void>;

/** Build the post-authentication report handler used by the inbound callback gate. */
export function createGraphReportRequestHandler(
  deps: GraphReportDeliveryDeps,
): GraphReportRequestHandler {
  const sendUnavailable = async (
    adapter: ChannelPort,
    channelId: string,
    options: DeliverToChannelOptions,
  ): Promise<void> => {
    const sent = await deps.deliveryService.deliverToChannel(
      adapter,
      channelId,
      "Report not available.",
      options,
    );
    if (!sent.ok || sent.value.platform.status !== "accepted") {
      deps.logger.warn({
        channelType: adapter.channelType,
        channelId,
        errorKind: "platform" as const,
        hint: "Check the channel adapter connection before requesting the report again",
      }, "Graph report unavailability notice failed");
    }
  };

  return async (graphId, channelType, channelId, adapter, options, sessionKey): Promise<void> => {
    const startedAt = deps.clock.now();
    const endpoint = ChannelEndpointSchema.safeParse(options.destinationEndpoint);
    const conversationRef = ConversationRefSchema.safeParse(options.authority?.conversationRef);
    if (
      !endpoint.success
      || options.authority === undefined
      || options.authority.tenantId.length === 0
      || options.authority.agentId.length === 0
      || !conversationRef.success
      || endpoint.data.channelType !== channelType
      || endpoint.data.channelType !== adapter.channelType
      || endpoint.data.channelInstanceId !== adapter.channelId
      || endpoint.data.conversationId !== channelId
      || endpoint.data.threadId !== options.threadId
    ) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "precondition" as const,
        hint: "Retry from the authenticated report callback with its exact captured channel endpoint",
      }, "Graph report delivery route rejected");
      return;
    }
    if (!GRAPH_ID_RE.test(graphId)) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "validation" as const,
        hint: "Discard the callback and verify graph report targets are minted by the interactive callback router",
      }, "Graph report request rejected");
      return;
    }

    const graphDirResult = tryCatch(() => safePath(safePath(deps.dataDir, "graph-runs"), graphId));
    if (!graphDirResult.ok) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "validation" as const,
        hint: "Discard the callback and verify the configured data directory and graph identifier",
      }, "Graph report path rejected");
      return;
    }
    const graphDir = graphDirResult.value;

    const graphStat = await fromPromise(lstat(graphDir));
    if (!graphStat.ok || !graphStat.value.isDirectory() || graphStat.value.isSymbolicLink()) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "validation" as const,
        hint: "Verify the graph run directory is an owner-controlled regular directory",
      }, "Graph report directory unavailable");
      await sendUnavailable(adapter, channelId, options);
      return;
    }

    const listed = await fromPromise(readdir(graphDir));
    if (!listed.ok) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "resource" as const,
        hint: "Check graph run directory permissions and retry the report request",
      }, "Graph report directory could not be read");
      await sendUnavailable(adapter, channelId, options);
      return;
    }

    const outputFiles = listed.value.filter((name) => name.endsWith("-output.md"));
    const completedNodes = new Set<string>();
    const metadataPathResult = tryCatch(() => safePath(graphDir, "_run-metadata.json"));
    if (metadataPathResult.ok) {
      const metadataStat = await fromPromise(lstat(metadataPathResult.value));
      if (
        metadataStat.ok
        && metadataStat.value.isFile()
        && !metadataStat.value.isSymbolicLink()
        && metadataStat.value.nlink === 1
        && metadataStat.value.size <= MAX_METADATA_BYTES
      ) {
        const metadataRaw = await readPinnedRegularFile(metadataPathResult.value, {
          dev: metadataStat.value.dev,
          ino: metadataStat.value.ino,
          size: metadataStat.value.size,
        }, MAX_METADATA_BYTES);
        if (metadataRaw.ok) {
          const parsed = tryCatch(() => JSON.parse(metadataRaw.value.toString("utf8")) as {
            nodes?: Record<string, { status?: unknown }>;
          });
          if (parsed.ok && parsed.value.nodes !== undefined) {
            for (const [nodeId, state] of Object.entries(parsed.value.nodes)) {
              if (state.status === "completed") completedNodes.add(nodeId);
            }
          }
        }
      }
    }

    let selected: { name: string; path: string; size: number; dev: number; ino: number } | undefined;
    let unsafeCandidate = false;
    for (const name of outputFiles) {
      const outputPathResult = tryCatch(() => safePath(graphDir, name));
      if (!outputPathResult.ok) {
        unsafeCandidate = true;
        continue;
      }
      const outputPath = outputPathResult.value;
      const outputStat = await fromPromise(lstat(outputPath));
      if (
        !outputStat.ok
        || !outputStat.value.isFile()
        || outputStat.value.isSymbolicLink()
        || outputStat.value.nlink !== 1
        || outputStat.value.size > MAX_REPORT_BYTES
      ) {
        unsafeCandidate = true;
        continue;
      }
      const nodeId = name.replace(/-output\.md$/, "");
      if (completedNodes.size > 0 && !completedNodes.has(nodeId)) continue;
      if (selected === undefined || outputStat.value.size > selected.size) {
        selected = {
          name,
          path: outputPath,
          size: outputStat.value.size,
          dev: outputStat.value.dev,
          ino: outputStat.value.ino,
        };
      }
    }

    if (selected === undefined) {
      deps.logger.warn({
        graphId,
        channelType,
        rejectedUnsafeCandidate: unsafeCandidate,
        errorKind: "validation" as const,
        hint: "Verify the completed graph produced a regular Markdown output file within the report size limit",
      }, "Graph report output unavailable");
      await sendUnavailable(adapter, channelId, options);
      return;
    }

    const nodeId = selected.name.replace(/-output\.md$/, "");
    const caption = `Full report — ${nodeId} (graph ${graphId.slice(0, 8)})`;
    if (typeof adapter.sendAttachment !== "function") {
      const sent = await deps.deliveryService.deliverToChannel(
        adapter,
        channelId,
        `${caption}\nAttachment delivery is not supported on this channel.`,
        options,
      );
      if (!sent.ok || sent.value.platform.status !== "accepted") {
        deps.logger.warn({
          graphId,
          channelType,
          channelId,
          errorKind: "platform" as const,
          hint: "Check the channel adapter connection and attachment capability",
        }, "Graph report fallback delivery failed");
      }
      return;
    }

    const { outwardLedger, resolveRootRunId } = deps.durability;
    const rootRun = resolveRootRunId?.(options.authority.agentId, sessionKey);
    if (!outwardLedger || !rootRun?.ok || rootRun.value.length === 0) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "precondition" as const,
        hint: "Restore the outward ledger and authenticated session root before requesting the report again",
      }, "Graph report durable delivery unavailable");
      await sendUnavailable(adapter, channelId, options);
      return;
    }

    const reportContent = await readPinnedRegularFile(selected.path, selected, MAX_REPORT_BYTES);
    if (!reportContent.ok) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "validation" as const,
        hint: "Retry only after verifying the graph output is a stable regular file owned by this run",
      }, "Graph report source changed before delivery");
      await sendUnavailable(adapter, channelId, options);
      return;
    }
    const snapshot = await writeOwnerOnlySnapshot(deps.dataDir, reportContent.value);
    if (!snapshot.ok) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "resource" as const,
        hint: "Check data directory permissions and free space before requesting the report again",
      }, "Graph report snapshot could not be created");
      await sendUnavailable(adapter, channelId, options);
      return;
    }

    const operationId = `graph-report:${createHash("sha256")
      .update(JSON.stringify({
        graphId,
        agentId: options.authority.agentId,
        sessionKey: formatSessionKey(sessionKey),
        endpoint: endpoint.data,
      }))
      .digest("hex")}`;
    const allocated = await outwardLedger.allocateStep(rootRun.value, operationId);
    if (!allocated.ok) {
      await fromPromise(unlink(snapshot.value));
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "dependency" as const,
        hint: "Restore outward-ledger writes before retrying the report request",
      }, "Graph report durable allocation failed");
      return;
    }

    const attachment = {
      type: "file" as const,
      url: snapshot.value,
      fileName: `report-${graphId.slice(0, 8)}.md`,
      mimeType: "text/markdown",
      caption,
    };
    const delivered = await wrapOutwardSend({
      ledger: outwardLedger,
      rootRunId: rootRun.value,
      outwardStepIndex: allocated.value,
      agentId: options.authority.agentId,
      channelType,
      channelId,
      operationKind: "message_send",
      operationOptions: {
        destinationEndpoint: endpoint.data,
        attachmentDigest: createHash("sha256").update(reportContent.value).digest("hex"),
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      },
      text: caption,
      doSend: async () => {
        const sentBoundary = await fromPromise(adapter.sendAttachment!(
          channelId,
          attachment,
          endpoint.data.threadId === undefined ? undefined : { threadId: endpoint.data.threadId },
        ));
        if (!sentBoundary.ok) return sentBoundary;
        if (!sentBoundary.value.ok) return sentBoundary.value;
        if (sentBoundary.value.value.kind !== "tracked") {
          return err(new Error("Graph report upload returned no durable platform receipt"));
        }
        return ok({ messageId: sentBoundary.value.value.messageId });
      },
      logger: deps.logger,
    });
    const cleaned = await fromPromise(unlink(snapshot.value));
    if (!cleaned.ok) {
      deps.logger.warn({
        graphId,
        channelType,
        errorKind: "resource" as const,
        hint: "Remove stale files from the graph-report-deliveries directory and verify its permissions",
      }, "Graph report snapshot cleanup failed");
    }
    if (!delivered.ok) {
      deps.logger.warn({
        graphId,
        channelType,
        channelId,
        errorMessage: sanitizeLogString(delivered.error.message),
        errorKind: "platform" as const,
        hint: "Inspect the retained outward operation and channel upload health before retrying",
      }, "Graph report attachment delivery failed");
      return;
    }
    deps.logger.info({
      graphId,
      channelType,
      channelId,
      durationMs: Math.max(0, deps.clock.now() - startedAt),
    }, "Graph report attachment delivered");
  };
}
