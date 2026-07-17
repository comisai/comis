// SPDX-License-Identifier: Apache-2.0
/** Delivery persistence rows, filters, and aggregate result types. @module */

import type { DeliveryFailureStage, DeliveryStatus, ErrorKind } from "@comis/core";

/** A delivery row (insert or query result). */
export interface DeliveryRow {
  id?: number;
  timestamp: number;
  traceId: string;
  agentId: string;
  channelType: string;
  channelId: string;
  sessionKey?: string;
  status: DeliveryStatus;
  latencyMs: number;
  errorMessage?: string;
  failureStage?: DeliveryFailureStage | null;
  errorKind?: ErrorKind | null;
  messagePreview?: string;
  toolCalls?: number | null;
  llmCalls?: number | null;
  tokensTotal?: number;
  costTotal?: number;
}

/** Delivery status breakdown statistics. */
export interface DeliveryStats {
  total: number;
  attempted: number;
  success: number;
  error: number;
  timeout: number;
  filtered: number;
  aborted: number;
  /** Exact latency total for attempted rows; used for lossless source merging. */
  attemptedLatencyMs: number;
  avgLatencyMs: number;
}

/** Query parameters for delivery rows. */
export interface DeliveryQueryParams {
  sinceMs?: number;
  beforeMs?: number;
  channelId?: string;
  channelType?: string;
  status?: DeliveryStatus;
  limit?: number;
}

/** Absolute-time bounds for delivery statistics. */
export interface DeliveryStatsQuery {
  sinceMs?: number;
  beforeMs?: number;
}
