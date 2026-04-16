/**
 * Context Engine section sub-editor for agent configuration.
 *
 * Renders all 27 ContextEngineConfigSchema fields organized in 4 groups:
 * - Core (2): enabled, version (mode selector)
 * - Shared (3): thinkingKeepTurns, compactionModel, evictionMinAge
 * - Pipeline-mode (6): historyTurns, observationKeepWindow, etc.
 * - DAG-mode (16): freshTailTurns, contextThreshold, etc.
 *
 * Pipeline/DAG groups show/hide based on the version selector.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  renderNumberField,
  renderTextField,
  renderTextarea,
  renderSelectField,
  renderCheckbox,
  getField,
  nothing,
} from "./editor-helpers.js";
import type { EditorForm, FieldChangeDetail } from "./editor-types.js";

@customElement("ic-agent-context-engine-editor")
export class IcAgentContextEngineEditor extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

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
      min-height: 60px;
      resize: vertical;
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
      width: 16px;
      height: 16px;
      cursor: pointer;
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--ic-space-md);
    }

    .section-title {
      font-size: var(--ic-text-sm);
      font-weight: 600;
      color: var(--ic-text);
      margin-top: var(--ic-space-md);
      margin-bottom: var(--ic-space-sm);
    }

    .divider {
      border: none;
      border-top: 1px solid var(--ic-border);
      margin: var(--ic-space-md) 0;
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
    const version = getField<string>(this.form, "contextEngine.version", "pipeline");

    return html`
      <!-- Core fields (always visible) -->
      ${renderCheckbox(this.form, "contextEngine.enabled", "Enabled", this._onChange)}
      ${renderSelectField(
        this.form,
        "contextEngine.version",
        "Mode",
        [
          { value: "pipeline", label: "Pipeline" },
          { value: "dag", label: "DAG" },
        ],
        this._onChange,
      )}

      <hr class="divider" />

      <!-- Shared fields (always visible) -->
      <div class="section-title">Shared Settings</div>
      ${renderNumberField(this.form, "contextEngine.thinkingKeepTurns", "Thinking Keep Turns", this._onChange, {
        min: "1",
        max: "50",
        placeholder: "10",
      })}
      ${renderTextField(this.form, "contextEngine.compactionModel", "Compaction Model", this._onChange, {
        placeholder: "anthropic:claude-haiku-4-5-20250929",
      })}
      ${renderNumberField(this.form, "contextEngine.evictionMinAge", "Eviction Min Age (turns)", this._onChange, {
        min: "3",
        max: "50",
        placeholder: "15",
      })}

      ${version === "pipeline" ? this._renderPipelineFields() : nothing}
      ${version === "dag" ? this._renderDagFields() : nothing}
    `;
  }

  private _renderPipelineFields() {
    return html`
      <hr class="divider" />
      <div class="section-title">Pipeline Settings</div>
      ${renderNumberField(this.form, "contextEngine.historyTurns", "History Turns", this._onChange, {
        min: "3",
        max: "100",
        placeholder: "15",
      })}
      ${renderNumberField(this.form, "contextEngine.observationKeepWindow", "Observation Keep Window", this._onChange, {
        min: "1",
        max: "50",
        placeholder: "25",
      })}
      ${renderNumberField(this.form, "contextEngine.observationTriggerChars", "Observation Trigger Chars", this._onChange, {
        min: "50000",
        max: "1000000",
        placeholder: "120000",
      })}
      ${renderNumberField(this.form, "contextEngine.observationDeactivationChars", "Observation Deactivation Chars", this._onChange, {
        min: "20000",
        max: "500000",
        placeholder: "80000",
      })}
      ${renderNumberField(this.form, "contextEngine.compactionCooldownTurns", "Compaction Cooldown Turns", this._onChange, {
        min: "1",
        max: "50",
        placeholder: "5",
      })}
      ${renderTextarea(this.form, "contextEngine.historyTurnOverrides", "History Turn Overrides (JSON)", this._onChange, {
        placeholder: '{"agentId": 20}',
      })}
    `;
  }

  private _renderDagFields() {
    return html`
      <hr class="divider" />
      <div class="section-title">DAG Settings</div>
      <div class="field-row">
        ${renderNumberField(this.form, "contextEngine.freshTailTurns", "Fresh Tail Turns", this._onChange, {
          min: "1",
          max: "50",
          placeholder: "8",
        })}
        ${renderNumberField(this.form, "contextEngine.contextThreshold", "Context Threshold", this._onChange, {
          step: "0.01",
          min: "0.1",
          max: "0.95",
          placeholder: "0.75",
        })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "contextEngine.leafMinFanout", "Leaf Min Fanout", this._onChange, {
          min: "2",
          max: "20",
          placeholder: "8",
        })}
        ${renderNumberField(this.form, "contextEngine.condensedMinFanout", "Condensed Min Fanout", this._onChange, {
          min: "2",
          max: "20",
          placeholder: "4",
        })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "contextEngine.condensedMinFanoutHard", "Condensed Min Fanout Hard", this._onChange, {
          min: "2",
          max: "10",
          placeholder: "2",
        })}
        ${renderNumberField(this.form, "contextEngine.incrementalMaxDepth", "Incremental Max Depth", this._onChange, {
          min: "-1",
          max: "10",
          placeholder: "0",
        })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "contextEngine.leafChunkTokens", "Leaf Chunk Tokens", this._onChange, {
          min: "1000",
          max: "100000",
          placeholder: "20000",
        })}
        ${renderNumberField(this.form, "contextEngine.leafTargetTokens", "Leaf Target Tokens", this._onChange, {
          min: "96",
          max: "5000",
          placeholder: "1200",
        })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "contextEngine.condensedTargetTokens", "Condensed Target Tokens", this._onChange, {
          min: "256",
          max: "10000",
          placeholder: "2000",
        })}
        ${renderNumberField(this.form, "contextEngine.maxExpandTokens", "Max Expand Tokens", this._onChange, {
          min: "500",
          max: "50000",
          placeholder: "4000",
        })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "contextEngine.maxRecallsPerDay", "Max Recalls Per Day", this._onChange, {
          min: "1",
          max: "100",
          placeholder: "10",
        })}
        ${renderNumberField(this.form, "contextEngine.recallTimeoutMs", "Recall Timeout (ms)", this._onChange, {
          min: "10000",
          max: "600000",
          placeholder: "120000",
        })}
      </div>
      ${renderNumberField(this.form, "contextEngine.largeFileTokenThreshold", "Large File Token Threshold", this._onChange, {
        min: "1000",
        max: "200000",
        placeholder: "25000",
      })}
      <div class="field-row">
        ${renderNumberField(this.form, "contextEngine.annotationKeepWindow", "Annotation Keep Window", this._onChange, {
          min: "1",
          max: "50",
          placeholder: "15",
        })}
        ${renderNumberField(this.form, "contextEngine.annotationTriggerChars", "Annotation Trigger Chars", this._onChange, {
          min: "10000",
          max: "1000000",
          placeholder: "200000",
        })}
      </div>
      ${renderTextField(this.form, "contextEngine.summaryModel", "Summary Model", this._onChange, {
        placeholder: "Override model for DAG summaries",
      })}
      ${renderTextField(this.form, "contextEngine.summaryProvider", "Summary Provider", this._onChange, {
        placeholder: "Override provider for DAG summaries",
      })}
    `;
  }
}
