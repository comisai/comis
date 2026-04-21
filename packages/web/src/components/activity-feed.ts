// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ActivityEntry } from "../api/types/index.js";
import type { SseEventHandler } from "../api/api-client.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import "./form/ic-filter-chips.js";

/** Event type display configuration */
const EVENT_CONFIG: Record<string, { label: string; color: string }> = {
  "message:received": { label: "MSG IN", color: "#3b82f6" },
  "message:sent": { label: "MSG OUT", color: "#22c55e" },
  "message:streaming": { label: "STREAM", color: "#8b5cf6" },
  "session:created": { label: "SESSION", color: "#06b6d4" },
  "session:expired": { label: "EXPIRED", color: "#6b7280" },
  "audit:event": { label: "AUDIT", color: "#f59e0b" },
  "skill:loaded": { label: "SKILL", color: "#10b981" },
  "skill:executed": { label: "SKILL RUN", color: "#10b981" },
  "skill:rejected": { label: "REJECTED", color: "#ef4444" },
  "scheduler:job_started": { label: "JOB START", color: "#8b5cf6" },
  "scheduler:job_completed": { label: "JOB DONE", color: "#22c55e" },
  "scheduler:heartbeat_check": { label: "HEARTBEAT", color: "#06b6d4" },
  "scheduler:task_extracted": { label: "TASK", color: "#f59e0b" },
  "system:error": { label: "ERROR", color: "#ef4444" },
};

/** Filter options derived from EVENT_CONFIG for ic-filter-chips */
const FILTER_OPTIONS = Object.entries(EVENT_CONFIG).map(([value, cfg]) => ({
  value,
  label: cfg.label,
  color: cfg.color,
}));

/** @internal -- exported for testing */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** @internal -- exported for testing */
export function summarizePayload(event: string, payload: Record<string, unknown>): string {
  if (event === "message:received" || event === "message:sent") {
    const channel = (payload["channelType"] ?? payload["channelId"] ?? "") as string;
    const text = (payload["text"] ?? "") as string;
    const preview = text.length > 60 ? text.slice(0, 57) + "..." : text;
    return channel ? `[${channel}] ${preview}` : preview;
  }

  if (event === "system:error") {
    return ((payload["message"] ?? payload["error"] ?? "Unknown error") as string).slice(0, 80);
  }

  if (event === "skill:executed" || event === "skill:loaded") {
    return (payload["skillName"] ?? payload["name"] ?? "unknown skill") as string;
  }

  if (event === "scheduler:job_completed" || event === "scheduler:job_started") {
    return (payload["taskId"] ?? payload["jobId"] ?? "") as string;
  }

  if (event === "audit:event") {
    return (payload["action"] ?? payload["type"] ?? "audit event") as string;
  }

  // Generic fallback
  const keys = Object.keys(payload).slice(0, 2);
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}: ${String(payload[k]).slice(0, 30)}`).join(", ");
}

/**
 * Activity feed component showing recent system events.
 *
 * Displays a scrollable list of events with type badges, relative
 * timestamps, and payload summaries. Supports real-time SSE updates
 * via the `sseSubscribe` property. Includes event type filtering via
 * toggle chips, pause/resume functionality, and a 200-entry ring buffer.
 */
@customElement("ic-activity-feed")
export class IcActivityFeed extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .feed-container {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: 0.75rem;
        overflow: hidden;
      }

      .feed-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.875rem 1.25rem;
        border-bottom: 1px solid var(--ic-border);
      }

      .feed-title {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--ic-text);
      }

      .header-controls {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .live-indicator {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.75rem;
        color: var(--ic-success);
      }

      .live-dot {
        width: 0.375rem;
        height: 0.375rem;
        border-radius: 50%;
        background: var(--ic-success);
        animation: pulse 2s infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }

      .paused-indicator {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.75rem;
        color: var(--ic-warning);
      }

      .paused-dot {
        width: 0.375rem;
        height: 0.375rem;
        border-radius: 50%;
        background: var(--ic-warning);
      }

      .pause-btn {
        background: transparent;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm, 0.25rem);
        padding: 0.125rem 0.5rem;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        cursor: pointer;
        font-family: inherit;
      }

      .pause-btn:hover {
        border-color: var(--ic-text-dim);
        color: var(--ic-text);
      }

      .feed-filters {
        padding: 0.5rem 1.25rem;
        border-bottom: 1px solid var(--ic-border);
      }

      .feed-list {
        max-height: 28rem;
        overflow-y: auto;
      }

      .feed-item {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 0.625rem 1.25rem;
        border-bottom: 1px solid var(--ic-border);
        font-size: 0.8125rem;
      }

      .feed-item:last-child {
        border-bottom: none;
      }

      .event-badge {
        padding: 0.125rem 0.5rem;
        border-radius: 0.25rem;
        font-size: 0.625rem;
        font-weight: 600;
        letter-spacing: 0.025em;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .event-summary {
        color: var(--ic-text-muted);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .event-time {
        color: var(--ic-text-dim);
        font-size: 0.75rem;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .empty-state {
        padding: 2rem 1.25rem;
        text-align: center;
        color: var(--ic-text-dim);
        font-size: 0.875rem;
      }
    `,
  ];

  @property({ attribute: false }) entries: ActivityEntry[] = [];
  @property({ attribute: false }) sseSubscribe: ((handler: SseEventHandler) => () => void) | null =
    null;
  @state() private _liveEntries: ActivityEntry[] = [];
  @state() private _activeFilters: Set<string> = new Set();
  @state() private _paused = false;
  @state() private _pauseBuffer: ActivityEntry[] = [];
  private _unsubscribe: (() => void) | null = null;
  private _nextLiveId = 100_000;

  override connectedCallback(): void {
    super.connectedCallback();
    this._startSse();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopSse();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("sseSubscribe")) {
      this._stopSse();
      this._startSse();
    }
  }

  private _startSse(): void {
    if (!this.sseSubscribe) return;

    this._unsubscribe = this.sseSubscribe((event, data) => {
      if (event === "ping" || event === "error") return;

      const entry: ActivityEntry = {
        id: this._nextLiveId++,
        event,
        payload: (data ?? {}) as Record<string, unknown>,
        timestamp: Date.now(),
      };

      if (this._paused) {
        this._pauseBuffer = [entry, ...this._pauseBuffer].slice(0, 200);
      } else {
        this._liveEntries = [entry, ...this._liveEntries].slice(0, 200);
      }
    });
  }

  private _stopSse(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  private _mergedEntries(): ActivityEntry[] {
    // Combine live entries (newest first) with initial entries (oldest first reversed)
    const initial = [...this.entries].reverse();
    const combined = [...this._liveEntries, ...initial];
    // Deduplicate by ID and cap at 200
    const seen = new Set<number>();
    const result: ActivityEntry[] = [];
    for (const e of combined) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      result.push(e);
      if (result.length >= 200) break;
    }
    return result;
  }

  private _onFilterChange(e: CustomEvent): void {
    this._activeFilters = e.detail.selected;
  }

  private _togglePause(): void {
    if (this._paused) {
      // Resume: merge buffered events into live entries
      this._liveEntries = [...this._pauseBuffer, ...this._liveEntries].slice(0, 200);
      this._pauseBuffer = [];
      this._paused = false;
    } else {
      this._paused = true;
    }
  }

  override render() {
    const allEntries = this._mergedEntries();
    const filtered =
      this._activeFilters.size === 0
        ? allEntries
        : allEntries.filter((e) => this._activeFilters.has(e.event));
    const hasLive = this._unsubscribe !== null;

    return html`
      <div class="feed-container" aria-label="Activity feed">
        <div class="feed-header">
          <span class="feed-title">Recent Activity</span>
          <div class="header-controls">
            ${
              hasLive
                ? this._paused
                  ? html`
                      <span class="paused-indicator">
                        <span class="paused-dot"></span>
                        Paused
                      </span>
                    `
                  : html`
                      <span class="live-indicator">
                        <span class="live-dot"></span>
                        Live
                      </span>
                    `
                : nothing
            }
            ${
              hasLive
                ? html`
                    <button
                      class="pause-btn"
                      @click=${this._togglePause}
                      aria-label=${this._paused ? "Resume live feed" : "Pause live feed"}
                    >
                      ${this._paused ? `Resume (${this._pauseBuffer.length})` : "Pause"}
                    </button>
                  `
                : nothing
            }
          </div>
        </div>

        <div class="feed-filters">
          <ic-filter-chips
            .options=${FILTER_OPTIONS}
            .selected=${this._activeFilters}
            @filter-change=${this._onFilterChange}
          ></ic-filter-chips>
        </div>

        <div class="feed-list" aria-live="polite">
          ${
            filtered.length === 0
              ? html`
                  <div class="empty-state">No activity yet</div>
                `
              : filtered.map((entry) => {
                  const config = EVENT_CONFIG[entry.event] ?? {
                    label: entry.event.toUpperCase(),
                    color: "#6b7280",
                  };
                  const summary = summarizePayload(entry.event, entry.payload);

                  return html`
                  <div class="feed-item">
                    <span
                      class="event-badge"
                      style="background: ${config.color}1a; color: ${config.color}"
                    >
                      ${config.label}
                    </span>
                    <span class="event-summary">${summary}</span>
                    <span class="event-time">${relativeTime(entry.timestamp)}</span>
                  </div>
                `;
                })
          }
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-activity-feed": IcActivityFeed;
  }
}
