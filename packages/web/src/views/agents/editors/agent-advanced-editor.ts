/**
 * Advanced section sub-editor for agent configuration.
 *
 * Renders: Cache retention, max context chars, RAG, concurrency,
 * safety (context guard, SDK retry), circuit breaker, model failover,
 * elevated reply, tracing, secrets & routing.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNumberField, renderSelectField, renderTextField, renderTextarea, renderCheckbox } from "./editor-helpers.js";
import type { EditorForm, FieldChangeDetail } from "./editor-types.js";

@customElement("ic-agent-advanced-editor")
export class IcAgentAdvancedEditor extends LitElement {
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
    .field select,
    .field textarea {
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
    .field select:focus,
    .field textarea:focus {
      border-color: var(--ic-accent);
    }

    .field textarea {
      min-height: 4rem;
      resize: vertical;
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--ic-space-md);
    }

    .checkbox-field {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--ic-space-sm);
      margin-bottom: var(--ic-space-md);
    }

    .checkbox-field label {
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
      text-transform: none;
      letter-spacing: normal;
      cursor: pointer;
    }

    .checkbox-field input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      accent-color: var(--ic-accent);
      cursor: pointer;
    }

    .checkbox-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
      gap: var(--ic-space-sm);
    }

    .divider {
      border: none;
      border-top: 1px solid var(--ic-border);
      margin: var(--ic-space-md) 0;
    }

    .section-title {
      font-weight: 600;
      margin-bottom: var(--ic-space-sm);
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
    }

    @media (max-width: 767px) {
      .field-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ attribute: false }) form: EditorForm = {};

  private _onChange = (key: string, value: unknown): void => {
    this.dispatchEvent(
      new CustomEvent<FieldChangeDetail>("field-change", {
        detail: { key, value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    return html`
      <div class="field-row">
        ${renderSelectField(this.form, "cacheRetention", "Cache Retention", [
          { value: "", label: "Default (long)" },
          { value: "none", label: "None" },
          { value: "short", label: "Short (5 min)" },
          { value: "long", label: "Long (1 hr)" },
        ], this._onChange, { id: "field-adv-cacheRetention" })}
        ${renderNumberField(this.form, "maxContextChars", "Max Context Chars", this._onChange, { id: "field-adv-maxContextChars" })}
      </div>

      <hr class="divider" />
      <div class="section-title">RAG</div>
      ${renderCheckbox(this.form, "advanced.rag.enabled", "Enabled", this._onChange, { id: "field-rag-enabled" })}
      <div class="field-row">
        ${renderNumberField(this.form, "advanced.rag.maxResults", "Max Results", this._onChange, { id: "field-rag-maxResults", min: "1" })}
        ${renderNumberField(this.form, "advanced.rag.minScore", "Min Score", this._onChange, { id: "field-rag-minScore", step: "0.01", min: "0", max: "1" })}
      </div>
      <div class="section-title">Trust Levels</div>
      <div class="checkbox-grid">
        ${renderCheckbox(this.form, "rag.trustLevels.system", "System", this._onChange, { id: "field-rag-trust-system" })}
        ${renderCheckbox(this.form, "rag.trustLevels.learned", "Learned", this._onChange, { id: "field-rag-trust-learned" })}
        ${renderCheckbox(this.form, "rag.trustLevels.external", "External", this._onChange, { id: "field-rag-trust-external" })}
      </div>

      <hr class="divider" />
      <div class="section-title">Concurrency</div>
      <div class="field-row">
        ${renderNumberField(this.form, "advanced.concurrency.maxConcurrent", "Max Concurrent Runs", this._onChange, { id: "field-conc-max", min: "1" })}
        ${renderNumberField(this.form, "advanced.concurrency.maxQueued", "Max Queued Per Session", this._onChange, { id: "field-conc-queued", min: "0" })}
      </div>

      <hr class="divider" />
      <div class="section-title">Safety</div>
      ${renderCheckbox(this.form, "safety.contextGuard.enabled", "Context Guard", this._onChange, { id: "field-safety-cg-enabled" })}
      <div class="field-row">
        ${renderNumberField(this.form, "safety.contextGuard.warnPct", "Warn at %", this._onChange, { id: "field-safety-cg-warn", min: "0", max: "100" })}
        ${renderNumberField(this.form, "safety.contextGuard.blockPct", "Block at %", this._onChange, { id: "field-safety-cg-block", min: "0", max: "100" })}
      </div>
      ${renderCheckbox(this.form, "safety.sdkRetry.enabled", "SDK Retry", this._onChange, { id: "field-safety-sdk-enabled" })}
      <div class="field-row">
        ${renderNumberField(this.form, "safety.sdkRetry.maxRetries", "Max Retries", this._onChange, { id: "field-safety-sdk-retries", min: "0" })}
        ${renderNumberField(this.form, "safety.sdkRetry.baseDelayMs", "Base Delay (ms)", this._onChange, { id: "field-safety-sdk-delay" })}
      </div>

      <hr class="divider" />
      <div class="section-title">Circuit Breaker</div>
      <div class="field-row">
        ${renderNumberField(this.form, "circuitBreaker.threshold", "Failure Threshold", this._onChange, { id: "field-cb-threshold", min: "1" })}
        ${renderNumberField(this.form, "circuitBreaker.resetTimeoutMs", "Reset Timeout (ms)", this._onChange, { id: "field-cb-resetMs" })}
      </div>

      <hr class="divider" />
      <div class="section-title">Model Failover</div>
      ${renderTextarea(this.form, "failover.fallbackModels", "Fallback Models (provider:model, one per line)", this._onChange, { id: "field-fo-fallback", placeholder: "openai:gpt-4o\nanthropic:claude-sonnet-4-5-20250929" })}
      ${renderTextarea(this.form, "failover.allowedModels", "Allowed Models (one per line)", this._onChange, { id: "field-fo-allowed" })}
      <div class="field-row">
        ${renderNumberField(this.form, "failover.maxAttempts", "Max Attempts", this._onChange, { id: "field-fo-maxAttempts", min: "1" })}
        ${renderNumberField(this.form, "failover.cooldownMs", "Cooldown (ms)", this._onChange, { id: "field-fo-cooldown" })}
      </div>
      ${renderTextarea(this.form, "failover.authProfiles", "Auth Profiles (JSON)", this._onChange, { id: "field-fo-auth" })}

      <hr class="divider" />
      <div class="section-title">Elevated Reply</div>
      ${renderCheckbox(this.form, "advanced.elevatedReply.enabled", "Enabled", this._onChange, { id: "field-adv-elevated" })}
      ${renderTextarea(this.form, "advanced.elevatedReply.recipients", "Recipients (one per line)", this._onChange, { id: "field-adv-elevated-recipients" })}

      <hr class="divider" />
      <div class="section-title">Tracing</div>
      ${renderCheckbox(this.form, "advanced.tracing.enabled", "Enabled", this._onChange, { id: "field-adv-tracing" })}
      ${renderTextField(this.form, "advanced.tracing.outputDir", "Output Dir", this._onChange, { id: "field-adv-tracing-dir", placeholder: "~/.comis/traces" })}

      <hr class="divider" />
      <div class="section-title">Secrets & Routing</div>
      ${renderTextarea(this.form, "advanced.secretsAccess", "Secrets Access (JSON)", this._onChange, { id: "field-adv-secrets" })}
      ${renderTextarea(this.form, "advanced.bootstrap", "Bootstrap (JSON)", this._onChange, { id: "field-adv-bootstrap" })}
      ${renderTextarea(this.form, "advanced.modelRoutes", "Model Routes (JSON)", this._onChange, { id: "field-adv-modelRoutes" })}
      ${renderTextField(this.form, "advanced.workspacePath", "Workspace Path", this._onChange, { id: "field-adv-workspace" })}
    `;
  }
}
