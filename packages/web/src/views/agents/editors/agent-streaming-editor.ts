/**
 * Streaming section sub-editor for system-wide streaming configuration.
 *
 * Renders: Default streaming settings, delivery timing, and block coalescer fields.
 * Unlike per-agent sub-editors, this uses config.read/config.patch RPC flow and
 * emits `config-change` events (not `field-change`).
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNumberField, renderSelectField, renderCheckbox } from "./editor-helpers.js";
import type { EditorForm } from "./editor-types.js";

/** Detail payload for config-change events from system-wide editors. */
export interface ConfigChangeDetail {
  section: string;
  key: string;
  value: unknown;
}

@customElement("ic-agent-streaming-editor")
export class IcAgentStreamingEditor extends LitElement {
  static override styles = css`
    :host { display: block; }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: var(--ic-space-md);
    }

    .field label {
      font-size: var(--ic-text-xs);
      color: var(--ic-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .field input,
    .field select {
      background: var(--ic-surface-2);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-md);
      padding: var(--ic-space-sm) var(--ic-space-md);
      color: var(--ic-text);
      font-family: inherit;
      font-size: var(--ic-text-sm);
      outline: none;
      transition: border-color var(--ic-transition);
    }

    .field input:focus,
    .field select:focus {
      border-color: var(--ic-accent);
    }

    .checkbox-field {
      display: flex;
      align-items: center;
      gap: var(--ic-space-sm);
      margin-bottom: var(--ic-space-md);
    }

    .checkbox-field label {
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
      cursor: pointer;
    }

    .checkbox-field input[type="checkbox"] {
      accent-color: var(--ic-accent);
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--ic-space-md);
    }

    .section-divider {
      margin: var(--ic-space-lg) 0 var(--ic-space-md);
      padding-bottom: var(--ic-space-sm);
      border-bottom: 1px solid var(--ic-border);
      font-size: var(--ic-text-xs);
      font-weight: 600;
      color: var(--ic-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    @media (max-width: 767px) {
      .field-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ attribute: false }) config: Record<string, unknown> = {};

  /** Read a config value with default fallback. */
  private _getConfig<T>(key: string, defaultValue: T): T {
    const val = this.config[key];
    return (val !== undefined && val !== null ? val : defaultValue) as T;
  }

  /** Read a nested timing field. */
  private _getTimingField<T>(key: string, defaultValue: T): T {
    const timing = this.config.defaultDeliveryTiming as Record<string, unknown> | undefined;
    const val = timing?.[key];
    return (val !== undefined && val !== null ? val : defaultValue) as T;
  }

  /** Read a nested coalescer field. */
  private _getCoalescerField<T>(key: string, defaultValue: T): T {
    const coalescer = this.config.defaultCoalescer as Record<string, unknown> | undefined;
    const val = coalescer?.[key];
    return (val !== undefined && val !== null ? val : defaultValue) as T;
  }

  /** Emit config-change for a root-level streaming field. */
  private _onRootChange = (key: string, value: unknown): void => {
    this.dispatchEvent(
      new CustomEvent<ConfigChangeDetail>("config-change", {
        detail: { section: "streaming", key, value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  /** Emit config-change for a nested timing field (sends full timing object). */
  private _onTimingChange = (subKey: string, value: unknown): void => {
    const currentTiming = (this.config.defaultDeliveryTiming as Record<string, unknown>) ?? {};
    this.dispatchEvent(
      new CustomEvent<ConfigChangeDetail>("config-change", {
        detail: {
          section: "streaming",
          key: "defaultDeliveryTiming",
          value: { ...currentTiming, [subKey]: value },
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  /** Emit config-change for a nested coalescer field (sends full coalescer object). */
  private _onCoalescerChange = (subKey: string, value: unknown): void => {
    const currentCoalescer = (this.config.defaultCoalescer as Record<string, unknown>) ?? {};
    this.dispatchEvent(
      new CustomEvent<ConfigChangeDetail>("config-change", {
        detail: {
          section: "streaming",
          key: "defaultCoalescer",
          value: { ...currentCoalescer, [subKey]: value },
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  /** Build a proxy form object for root-level fields. */
  private _rootForm(): EditorForm {
    return new Proxy({} as EditorForm, {
      get: (_target, prop: string) => this._getConfig(prop, undefined),
    });
  }

  /** Build a proxy form object for timing fields. */
  private _timingForm(): EditorForm {
    return new Proxy({} as EditorForm, {
      get: (_target, prop: string) => this._getTimingField(prop, undefined),
    });
  }

  /** Build a proxy form object for coalescer fields. */
  private _coalescerForm(): EditorForm {
    return new Proxy({} as EditorForm, {
      get: (_target, prop: string) => this._getCoalescerField(prop, undefined),
    });
  }

  override render() {
    const rootForm = this._rootForm();
    const timingForm = this._timingForm();
    const coalescerForm = this._coalescerForm();

    return html`
      <!-- Defaults -->
      ${renderCheckbox(rootForm, "enabled", "Enabled", this._onRootChange)}

      <div class="field-row">
        ${renderSelectField(rootForm, "defaultChunkMode", "Default Chunk Mode", [
          { value: "paragraph", label: "Paragraph" },
          { value: "newline", label: "Newline" },
          { value: "sentence", label: "Sentence" },
          { value: "length", label: "Length" },
        ], this._onRootChange)}
        ${renderSelectField(rootForm, "defaultTypingMode", "Default Typing Mode", [
          { value: "never", label: "Never" },
          { value: "instant", label: "Instant" },
          { value: "thinking", label: "Thinking" },
          { value: "message", label: "Message" },
        ], this._onRootChange)}
      </div>

      <div class="field-row">
        ${renderNumberField(rootForm, "defaultTypingRefreshMs", "Default Typing Refresh (ms)", this._onRootChange, { placeholder: "6000" })}
        ${renderSelectField(rootForm, "defaultTableMode", "Default Table Mode", [
          { value: "code", label: "Code" },
          { value: "bullets", label: "Bullets" },
          { value: "off", label: "Off" },
        ], this._onRootChange)}
      </div>

      <div class="field-row">
        ${renderCheckbox(rootForm, "defaultUseMarkdownIR", "Use Markdown IR", this._onRootChange)}
        ${renderSelectField(rootForm, "defaultReplyMode", "Default Reply Mode", [
          { value: "off", label: "Off" },
          { value: "first", label: "First" },
          { value: "all", label: "All" },
        ], this._onRootChange)}
      </div>

      <!-- Delivery Timing -->
      <div class="section-divider">Delivery Timing</div>

      ${renderSelectField(timingForm, "mode", "Mode", [
        { value: "off", label: "Off" },
        { value: "natural", label: "Natural" },
        { value: "custom", label: "Custom" },
        { value: "adaptive", label: "Adaptive" },
      ], this._onTimingChange)}

      <div class="field-row">
        ${renderNumberField(timingForm, "minMs", "Min (ms)", this._onTimingChange, { placeholder: "800" })}
        ${renderNumberField(timingForm, "maxMs", "Max (ms)", this._onTimingChange, { placeholder: "2500" })}
      </div>

      <div class="field-row">
        ${renderNumberField(timingForm, "jitterMs", "Jitter (ms)", this._onTimingChange, { placeholder: "200" })}
        ${renderNumberField(timingForm, "firstBlockDelayMs", "First Block Delay (ms)", this._onTimingChange, { placeholder: "0" })}
      </div>

      <!-- Block Coalescer -->
      <div class="section-divider">Block Coalescer</div>

      <div class="field-row">
        ${renderNumberField(coalescerForm, "minChars", "Min Chars", this._onCoalescerChange, { placeholder: "0" })}
        ${renderNumberField(coalescerForm, "maxChars", "Max Chars", this._onCoalescerChange, { placeholder: "500" })}
      </div>

      <div class="field-row">
        ${renderNumberField(coalescerForm, "idleMs", "Idle (ms)", this._onCoalescerChange, { placeholder: "1500" })}
        ${renderSelectField(coalescerForm, "codeBlockPolicy", "Code Block Policy", [
          { value: "standalone", label: "Standalone" },
          { value: "coalesce", label: "Coalesce" },
        ], this._onCoalescerChange)}
      </div>

      ${renderCheckbox(coalescerForm, "adaptiveIdle", "Adaptive Idle", this._onCoalescerChange)}
    `;
  }
}
