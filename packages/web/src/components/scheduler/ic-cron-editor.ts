// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/* ------------------------------------------------------------------ */
/*  Local types - DO NOT import from @comis/scheduler              */
/* ------------------------------------------------------------------ */

export interface CronScheduleInput {
  kind: "cron" | "every" | "at";
  expr?: string;
  tz?: string;
  everyMs?: number;
  at?: string;
}

export interface CronJobInput {
  id: string;
  name: string;
  agentId: string;
  schedule: CronScheduleInput;
  message: string;
  enabled: boolean;
  maxConcurrent: number;
  sessionTarget: "main" | "isolated";
  deliveryTarget?: {
    channelId: string;
    userId: string;
    tenantId: string;
    channelType?: string;
  };
}

/* ------------------------------------------------------------------ */
/*  Next-runs calculators (exported for testing)                      */
/* ------------------------------------------------------------------ */

/** Parse a single cron field (minute, hour, dom, month, dow) into the set of matching values. */
function parseCronField(field: string, min: number, max: number): number[] | null {
  const results = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();
    // step pattern: */N or range/N
    const stepMatch = trimmed.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const stepVal = parseInt(stepMatch[4], 10);
      if (stepVal <= 0) return null;
      let start = min;
      let end = max;
      if (stepMatch[2] !== undefined && stepMatch[3] !== undefined) {
        start = parseInt(stepMatch[2], 10);
        end = parseInt(stepMatch[3], 10);
      }
      if (start < min || end > max || start > end) return null;
      for (let i = start; i <= end; i += stepVal) {
        results.add(i);
      }
      continue;
    }

    // wildcard
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) results.add(i);
      continue;
    }

    // range: N-M
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const s = parseInt(rangeMatch[1], 10);
      const e = parseInt(rangeMatch[2], 10);
      if (s < min || e > max || s > e) return null;
      for (let i = s; i <= e; i++) results.add(i);
      continue;
    }

    // single number
    if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (n < min || n > max) return null;
      results.add(n);
      continue;
    }

    // unrecognized token
    return null;
  }

  return results.size > 0 ? Array.from(results).sort((a, b) => a - b) : null;
}

/**
 * Compute the next N fire times for a 5-field cron expression.
 * Fields: minute hour dom month dow
 *
 * Iterates minute-by-minute from `from` up to 366 days ahead.
 */
export function computeNextCronRuns(
  expr: string,
  tz: string | undefined,
  count: number,
  from: Date,
): Date[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 6);

  if (!minutes || !hours || !doms || !months || !dows) return [];

  const minuteSet = new Set(minutes);
  const hourSet = new Set(hours);
  const domSet = new Set(doms);
  const monthSet = new Set(months);
  const dowSet = new Set(dows);

  const results: Date[] = [];
  const maxMs = 366 * 24 * 60 * 60 * 1000;
  const endTime = from.getTime() + maxMs;

  // Start one minute past `from`
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + 60_000);

  while (cursor.getTime() <= endTime && results.length < count) {
    const m = cursor.getMinutes();
    const h = cursor.getHours();
    const dom = cursor.getDate();
    const mon = cursor.getMonth() + 1;
    const dow = cursor.getDay();

    if (minuteSet.has(m) && hourSet.has(h) && domSet.has(dom) && monthSet.has(mon) && dowSet.has(dow)) {
      results.push(new Date(cursor));
    }

    cursor.setTime(cursor.getTime() + 60_000);
  }

  return results;
}

/**
 * Compute the next N fire times for an interval-based schedule.
 */
export function computeNextEveryRuns(everyMs: number, count: number, from: Date): Date[] {
  if (everyMs <= 0 || !Number.isFinite(everyMs)) return [];
  const results: Date[] = [];
  let t = from.getTime();
  for (let i = 0; i < count; i++) {
    t += everyMs;
    results.push(new Date(t));
  }
  return results;
}

/**
 * Compute fire times for a one-shot schedule.
 * Returns a single-element array if the datetime is in the future, empty otherwise.
 */
export function computeNextAtRun(at: string, from?: Date): Date[] {
  const d = new Date(at);
  if (isNaN(d.getTime())) return [];
  const ref = from ?? new Date();
  return d.getTime() > ref.getTime() ? [d] : [];
}

/**
 * Format a Date for display in the next-runs list.
 * Example: "Mon 2026-03-02 09:00 EST"
 */
function formatRunDate(d: Date, tz?: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || undefined,
      timeZoneName: "short",
      hour12: false,
    });
    return fmt.format(d);
  } catch {
    return d.toISOString();
  }
}

/* ------------------------------------------------------------------ */
/*  Common timezone list                                              */
/* ------------------------------------------------------------------ */

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
] as const;

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

/**
 * Cron job editor form.
 *
 * Reusable form component for creating and editing cron jobs.
 * Includes schedule kind switching, next-5-runs preview, and
 * fires `save` / `cancel` CustomEvents.
 *
 * @fires save - CustomEvent<CronJobInput> when save button is clicked
 * @fires cancel - CustomEvent (no detail) when cancel button is clicked
 *
 * @example
 * ```html
 * <ic-cron-editor
 *   .agents=${["default", "assistant"]}
 *   @save=${this._onSave}
 *   @cancel=${this._onCancel}
 * ></ic-cron-editor>
 * ```
 */
@customElement("ic-cron-editor")
export class IcCronEditor extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .editor-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      h2 {
        margin: 0 0 var(--ic-space-lg);
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
      }

      .form-grid {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        font-weight: 500;
      }

      input,
      select,
      textarea {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        transition: border-color var(--ic-transition);
        width: 100%;
      }

      input::placeholder,
      textarea::placeholder {
        color: var(--ic-text-dim);
      }

      input:focus,
      select:focus,
      textarea:focus {
        border-color: var(--ic-accent);
        outline: none;
      }

      input:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      select {
        appearance: auto;
        cursor: pointer;
      }

      textarea {
        resize: vertical;
        min-height: 4rem;
      }

      .checkbox-field {
        flex-direction: row;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .checkbox-field input[type="checkbox"] {
        width: auto;
        accent-color: var(--ic-accent);
      }

      .kind-group {
        display: flex;
        gap: var(--ic-space-md);
      }

      .kind-option {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        cursor: pointer;
      }

      .kind-option input[type="radio"] {
        width: auto;
        accent-color: var(--ic-accent);
      }

      .kind-option label {
        cursor: pointer;
      }

      .next-runs {
        margin-top: var(--ic-space-sm);
      }

      .next-runs h3 {
        margin: 0 0 var(--ic-space-xs);
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .next-runs ul {
        list-style: disc;
        margin: 0;
        padding-left: var(--ic-space-lg);
      }

      .next-runs li {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        line-height: 1.6;
      }

      .next-runs .empty-msg {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-style: italic;
      }

      .button-row {
        display: flex;
        justify-content: flex-end;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-lg);
      }

      .btn {
        padding: var(--ic-space-sm) var(--ic-space-lg);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
        transition:
          background var(--ic-transition),
          border-color var(--ic-transition);
      }

      .btn-cancel {
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .btn-cancel:hover {
        border-color: var(--ic-text-muted);
        color: var(--ic-text);
      }

      .btn-save {
        background: var(--ic-accent);
        border: 1px solid var(--ic-accent);
        color: #fff;
      }

      .btn-save:hover {
        filter: brightness(1.1);
      }
    `,
  ];

  /* ---- Public properties ---- */

  /** Pre-fill form when editing an existing job. */
  @property({ type: Object }) job: CronJobInput | null = null;

  /** Controls title and ID field editability. */
  @property() mode: "create" | "edit" = "create";

  /** Available agent IDs for the agent dropdown. */
  @property({ type: Array }) agents: string[] = [];

  /* ---- Internal state ---- */

  @state() private _id = "";
  @state() private _name = "";
  @state() private _scheduleKind: "cron" | "every" | "at" = "cron";
  @state() private _cronExpr = "";
  @state() private _timezone = "UTC";
  @state() private _everyMs = 60_000;
  @state() private _atDateTime = "";
  @state() private _enabled = true;
  @state() private _agentId = "";
  @state() private _message = "";
  @state() private _maxConcurrent = 1;
  @state() private _sessionTarget: "main" | "isolated" = "main";
  @state() private _deliveryMode: "none" | "origin" | "custom" = "none";
  @state() private _deliveryChannelType = "";
  @state() private _deliveryChannelId = "";
  @state() private _nextRuns: string[] = [];

  private _previewTimer: ReturnType<typeof setTimeout> | null = null;

  /* ---- Lifecycle ---- */

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("job") && this.job) {
      this._populateFromJob(this.job);
    }
    // Default agentId to first available agent in create mode
    if (changed.has("agents") && this.agents.length > 0 && !this._agentId) {
      this._agentId = this.agents[0];
    }
  }

  override updated(changed: Map<string, unknown>): void {
    const scheduleFields: Array<keyof this> = [
      "_scheduleKind" as keyof this,
      "_cronExpr" as keyof this,
      "_timezone" as keyof this,
      "_everyMs" as keyof this,
      "_atDateTime" as keyof this,
    ];
    const needsPreview = scheduleFields.some((f) => changed.has(f as string));
    if (needsPreview) {
      this._schedulePreviewDebounced();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._previewTimer !== null) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
  }

  /* ---- Populate from job ---- */

  private _populateFromJob(job: CronJobInput): void {
    this._id = job.id;
    this._name = job.name;
    this._agentId = job.agentId;
    this._message = job.message;
    this._enabled = job.enabled;
    this._maxConcurrent = job.maxConcurrent;
    this._sessionTarget = job.sessionTarget;
    this._scheduleKind = job.schedule.kind;
    this._cronExpr = job.schedule.expr ?? "";
    this._timezone = job.schedule.tz ?? "UTC";
    this._everyMs = job.schedule.everyMs ?? 60_000;
    this._atDateTime = job.schedule.at ?? "";
    if (job.deliveryTarget) {
      this._deliveryMode = "origin";
      this._deliveryChannelType = job.deliveryTarget.channelType ?? "";
      this._deliveryChannelId = job.deliveryTarget.channelId ?? "";
    } else {
      this._deliveryMode = "none";
      this._deliveryChannelType = "";
      this._deliveryChannelId = "";
    }
  }

  /* ---- Preview ---- */

  private _schedulePreviewDebounced(): void {
    if (this._previewTimer !== null) {
      clearTimeout(this._previewTimer);
    }
    this._previewTimer = setTimeout(() => {
      this._computePreview();
    }, 500);
  }

  private _computePreview(): void {
    const now = new Date();
    let runs: Date[] = [];

    switch (this._scheduleKind) {
      case "cron":
        runs = computeNextCronRuns(this._cronExpr, this._timezone, 5, now);
        break;
      case "every":
        runs = computeNextEveryRuns(this._everyMs, 5, now);
        break;
      case "at":
        runs = computeNextAtRun(this._atDateTime, now);
        break;
    }

    this._nextRuns = runs.map((d) =>
      formatRunDate(d, this._scheduleKind === "cron" ? this._timezone : undefined),
    );
  }

  /* ---- Assemble output ---- */

  private _assembleJob(): CronJobInput {
    const schedule: CronScheduleInput = { kind: this._scheduleKind };
    switch (this._scheduleKind) {
      case "cron":
        schedule.expr = this._cronExpr;
        schedule.tz = this._timezone;
        break;
      case "every":
        schedule.everyMs = this._everyMs;
        break;
      case "at":
        schedule.at = this._atDateTime;
        break;
    }

    let deliveryTarget: CronJobInput["deliveryTarget"];
    if (this._deliveryMode === "origin" && this.job?.deliveryTarget) {
      deliveryTarget = this.job.deliveryTarget;
    } else if (this._deliveryMode === "custom") {
      deliveryTarget = {
        channelId: this._deliveryChannelId,
        channelType: this._deliveryChannelType,
        userId: "system",
        tenantId: "default",
      };
    }

    return {
      id: this._id,
      name: this._name,
      agentId: this._agentId,
      schedule,
      message: this._message,
      enabled: this._enabled,
      maxConcurrent: this._maxConcurrent,
      sessionTarget: this._sessionTarget,
      deliveryTarget,
    };
  }

  /* ---- Event handlers ---- */

  private _onSave(): void {
    this.dispatchEvent(
      new CustomEvent("save", { detail: this._assembleJob() }),
    );
  }

  private _onCancel(): void {
    this.dispatchEvent(new CustomEvent("cancel"));
  }

  /* ---- Render ---- */

  override render() {
    const title = this.mode === "edit" ? "Edit Cron Job" : "New Cron Job";

    return html`
      <div class="editor-card">
        <h2>${title}</h2>

        <div class="form-grid">
          <!-- ID -->
          <div class="field">
            <label for="cron-id">ID</label>
            <input
              id="cron-id"
              type="text"
              .value=${this._id}
              ?disabled=${this.mode === "edit"}
              placeholder="e.g. daily-report"
              @input=${(e: InputEvent) => { this._id = (e.target as HTMLInputElement).value; }}
            />
          </div>

          <!-- Name -->
          <div class="field">
            <label for="cron-name">Name</label>
            <input
              id="cron-name"
              type="text"
              .value=${this._name}
              placeholder="Human-readable name"
              @input=${(e: InputEvent) => { this._name = (e.target as HTMLInputElement).value; }}
            />
          </div>

          <!-- Schedule Kind -->
          <div class="field">
            <label>Schedule Kind</label>
            <div class="kind-group">
              <label class="kind-option">
                <input
                  type="radio"
                  name="schedule-kind"
                  value="cron"
                  .checked=${this._scheduleKind === "cron"}
                  @change=${() => { this._scheduleKind = "cron"; }}
                />
                <span>Cron</span>
              </label>
              <label class="kind-option">
                <input
                  type="radio"
                  name="schedule-kind"
                  value="every"
                  .checked=${this._scheduleKind === "every"}
                  @change=${() => { this._scheduleKind = "every"; }}
                />
                <span>Interval</span>
              </label>
              <label class="kind-option">
                <input
                  type="radio"
                  name="schedule-kind"
                  value="at"
                  .checked=${this._scheduleKind === "at"}
                  @change=${() => { this._scheduleKind = "at"; }}
                />
                <span>One-shot</span>
              </label>
            </div>
          </div>

          <!-- Cron fields -->
          ${this._scheduleKind === "cron" ? html`
            <div class="field">
              <label for="cron-expr">Schedule Expression</label>
              <input
                id="cron-expr"
                type="text"
                .value=${this._cronExpr}
                placeholder="0 9 * * *"
                @input=${(e: InputEvent) => { this._cronExpr = (e.target as HTMLInputElement).value; }}
              />
            </div>
            <div class="field">
              <label for="cron-tz">Timezone</label>
              <select
                id="cron-tz"
                .value=${this._timezone}
                @change=${(e: Event) => { this._timezone = (e.target as HTMLSelectElement).value; }}
              >
                ${TIMEZONES.map(
                  (tz) => html`<option value=${tz} ?selected=${tz === this._timezone}>${tz}</option>`,
                )}
              </select>
            </div>
          ` : nothing}

          <!-- Interval field -->
          ${this._scheduleKind === "every" ? html`
            <div class="field">
              <label for="cron-interval">Interval (minutes)</label>
              <input
                id="cron-interval"
                type="number"
                min="1"
                .value=${String(Math.round(this._everyMs / 60_000))}
                @input=${(e: InputEvent) => {
                  const mins = parseInt((e.target as HTMLInputElement).value, 10);
                  if (!isNaN(mins) && mins > 0) this._everyMs = mins * 60_000;
                }}
              />
            </div>
          ` : nothing}

          <!-- One-shot field -->
          ${this._scheduleKind === "at" ? html`
            <div class="field">
              <label for="cron-at">Run At</label>
              <input
                id="cron-at"
                type="datetime-local"
                .value=${this._atDateTime}
                @input=${(e: InputEvent) => { this._atDateTime = (e.target as HTMLInputElement).value; }}
              />
            </div>
          ` : nothing}

          <!-- Enabled -->
          <div class="field checkbox-field">
            <input
              id="cron-enabled"
              type="checkbox"
              .checked=${this._enabled}
              @change=${(e: Event) => { this._enabled = (e.target as HTMLInputElement).checked; }}
            />
            <label for="cron-enabled">Enabled</label>
          </div>

          <!-- Agent -->
          <div class="field">
            <label for="cron-agent">Agent</label>
            <select
              id="cron-agent"
              .value=${this._agentId}
              @change=${(e: Event) => { this._agentId = (e.target as HTMLSelectElement).value; }}
            >
              ${this.agents.length === 0
                ? html`<option value="">No agents available</option>`
                : this.agents.map(
                    (a) => html`<option value=${a} ?selected=${a === this._agentId}>${a}</option>`,
                  )}
            </select>
          </div>

          <!-- Message -->
          <div class="field">
            <label for="cron-message">Message</label>
            <textarea
              id="cron-message"
              rows="3"
              .value=${this._message}
              placeholder="Message to send to the agent..."
              @input=${(e: InputEvent) => { this._message = (e.target as HTMLTextAreaElement).value; }}
            ></textarea>
          </div>

          <!-- Session Target -->
          <div class="field">
            <label for="cron-session">Session Target</label>
            <select
              id="cron-session"
              .value=${this._sessionTarget}
              @change=${(e: Event) => { this._sessionTarget = (e.target as HTMLSelectElement).value as "main" | "isolated"; }}
            >
              <option value="main" ?selected=${this._sessionTarget === "main"}>Main</option>
              <option value="isolated" ?selected=${this._sessionTarget === "isolated"}>Isolated</option>
            </select>
          </div>

          <!-- Delivery Target -->
          <div class="field">
            <label for="cron-delivery">Delivery</label>
            <select
              id="cron-delivery"
              .value=${this._deliveryMode}
              @change=${(e: Event) => { this._deliveryMode = (e.target as HTMLSelectElement).value as "none" | "origin" | "custom"; }}
            >
              <option value="none" ?selected=${this._deliveryMode === "none"}>None (local only)</option>
              <option value="origin" ?selected=${this._deliveryMode === "origin"}>Origin (captured channel)</option>
              <option value="custom" ?selected=${this._deliveryMode === "custom"}>Custom channel</option>
            </select>
          </div>
          ${this._deliveryMode === "origin" && this.job?.deliveryTarget ? html`
            <div class="field">
              <label>Current target</label>
              <span style="font-size:var(--ic-text-sm);color:var(--ic-text-dim)">${this.job.deliveryTarget.channelType ?? "unknown"}:${this.job.deliveryTarget.channelId}</span>
            </div>
          ` : nothing}
          ${this._deliveryMode === "custom" ? html`
            <div class="field">
              <label for="cron-delivery-type">Channel Type</label>
              <input
                id="cron-delivery-type"
                type="text"
                .value=${this._deliveryChannelType}
                placeholder="telegram"
                @input=${(e: InputEvent) => { this._deliveryChannelType = (e.target as HTMLInputElement).value; }}
              />
            </div>
            <div class="field">
              <label for="cron-delivery-id">Channel ID</label>
              <input
                id="cron-delivery-id"
                type="text"
                .value=${this._deliveryChannelId}
                placeholder="-100372..."
                @input=${(e: InputEvent) => { this._deliveryChannelId = (e.target as HTMLInputElement).value; }}
              />
            </div>
          ` : nothing}

          <!-- Max Concurrent -->
          <div class="field">
            <label for="cron-max">Max Concurrent</label>
            <input
              id="cron-max"
              type="number"
              min="1"
              .value=${String(this._maxConcurrent)}
              @input=${(e: InputEvent) => {
                const v = parseInt((e.target as HTMLInputElement).value, 10);
                if (!isNaN(v) && v >= 1) this._maxConcurrent = v;
              }}
            />
          </div>

          <!-- Next 5 runs preview -->
          <div class="next-runs">
            <h3>Next 5 runs</h3>
            ${this._nextRuns.length > 0
              ? html`
                <ul>
                  ${this._nextRuns.map((r) => html`<li>${r}</li>`)}
                </ul>
              `
              : html`<p class="empty-msg">Enter a valid schedule</p>`}
          </div>
        </div>

        <!-- Buttons -->
        <div class="button-row">
          <button class="btn btn-cancel" @click=${this._onCancel}>Cancel</button>
          <button class="btn btn-save" @click=${this._onSave}>Save</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-cron-editor": IcCronEditor;
  }
}
