// SPDX-License-Identifier: Apache-2.0
/**
 * Media test view for operator testing of STT, TTS, Vision, Document,
 * Video, and Link processing capabilities.
 *
 * @module
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { SttTestResult, TtsTestResult, VisionTestResult, DocumentTestResult, VideoTestResult, LinkTestResult, MediaProvidersInfo } from "../api/types/media-types.js";
import { IcToast } from "../components/feedback/ic-toast.js";

// Side-effect imports for sub-components
import "../components/nav/ic-tabs.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Tab definitions for the media test view. */
const TABS = [
  { id: "stt", label: "STT" },
  { id: "tts", label: "TTS" },
  { id: "vision", label: "Vision" },
  { id: "document", label: "Document" },
  { id: "video", label: "Video" },
  { id: "link", label: "Link" },
];

/** Maximum file size for STT upload (25 MB). */
const MAX_STT_FILE_SIZE = 25 * 1024 * 1024;

/** Maximum file size for vision upload (20 MB). */
const MAX_VISION_FILE_SIZE = 20 * 1024 * 1024;

/** Maximum file size for document/video upload (50 MB). */
const MAX_DOC_VIDEO_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Efficiently convert an ArrayBuffer to a base64 string using chunked
 * String.fromCharCode to avoid O(n^2) string concatenation.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

/**
 * Media test view with STT and TTS tabs for operator verification.
 *
 * STT: Upload audio file, get transcription text with provider info.
 * TTS: Enter text, synthesize speech, play audio in browser.
 *
 * Checks media.providers on load for provider availability info.
 * Gracefully degrades when provider info is unavailable.
 */
@customElement("ic-media-test-view")
export class IcMediaTestView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-md);
      }

      .header-title {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
      }

      .tab-content {
        margin-top: var(--ic-space-md);
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-lg);
        max-width: 640px;
      }

      .card-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-sm);
      }

      .provider-info {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-md);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        background: var(--ic-surface-2);
        border-radius: var(--ic-radius-sm);
      }

      .provider-info.warning {
        color: var(--ic-warning);
        border: 1px solid var(--ic-warning);
      }

      .file-input-wrapper {
        margin-bottom: var(--ic-space-md);
      }

      .file-label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-xs);
        display: block;
      }

      .file-hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-xs);
      }

      input[type="file"] {
        width: 100%;
        padding: var(--ic-space-sm);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      input[type="file"]::file-selector-button {
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-sm);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        margin-right: var(--ic-space-sm);
      }

      textarea {
        width: 100%;
        min-height: 100px;
        padding: var(--ic-space-sm);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        resize: vertical;
        box-sizing: border-box;
      }

      textarea:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .text-input {
        width: 100%;
        padding: var(--ic-space-sm);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        box-sizing: border-box;
      }

      .text-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .input-label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-xs);
        display: block;
      }

      .input-group {
        margin-bottom: var(--ic-space-md);
      }

      .btn-primary {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition);
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--ic-accent-hover);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .result-box {
        margin-top: var(--ic-space-md);
        padding: var(--ic-space-md);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
      }

      .result-label {
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--ic-space-xs);
      }

      .result-text {
        white-space: pre-wrap;
        word-break: break-word;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        line-height: 1.5;
        max-height: 300px;
        overflow-y: auto;
      }

      .result-meta {
        margin-top: var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        display: flex;
        gap: var(--ic-space-md);
      }

      .audio-player {
        margin-top: var(--ic-space-md);
      }

      .audio-player audio {
        width: 100%;
      }

      .spinner-inline {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        margin-top: var(--ic-space-sm);
      }

      .image-preview {
        margin-bottom: var(--ic-space-md);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
        max-width: 400px;
      }

      .image-preview img {
        display: block;
        max-width: 100%;
        height: auto;
      }

      .result-text--scrollable {
        max-height: 400px;
        overflow-y: auto;
      }

      .truncated-badge {
        color: var(--ic-warning);
        font-weight: 600;
      }

    `,
  ];

  @property({ attribute: false }) rpcClient!: RpcClient;
  @property({ attribute: false }) apiClient!: ApiClient;

  @state() private _activeTab = "stt";
  @state() private _processing = false;
  @state() private _sttResult: SttTestResult | null = null;
  @state() private _ttsResult: TtsTestResult | null = null;
  @state() private _audioUrl: string | null = null;
  @state() private _ttsText = "";
  @state() private _ttsVoice = "";
  @state() private _visionResult: VisionTestResult | null = null;
  @state() private _documentResult: DocumentTestResult | null = null;
  @state() private _videoResult: VideoTestResult | null = null;
  @state() private _visionPrompt = "";
  @state() private _videoPrompt = "";
  @state() private _linkUrl = "";
  @state() private _linkResult: LinkTestResult | null = null;
  @state() private _loadState: LoadState = "loaded";
  @state() private _providers: MediaProvidersInfo | null = null;

  /** Object URL for vision image preview (revoked on cleanup). */
  private _imagePreviewUrl: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._loadProviders();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._audioUrl) {
      URL.revokeObjectURL(this._audioUrl);
      this._audioUrl = null;
    }
    if (this._imagePreviewUrl) {
      URL.revokeObjectURL(this._imagePreviewUrl);
      this._imagePreviewUrl = null;
    }
  }

  /** Attempt to load provider availability. Degrades gracefully when handler is missing. */
  private async _loadProviders(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const res = await this.rpcClient.call("media.providers") as MediaProvidersInfo;
      this._providers = res;
    } catch {
      // media.providers handler may not exist -- degrade gracefully
      this._providers = null;
    }
  }

  // ---------------------------------------------------------------------------
  // STT
  // ---------------------------------------------------------------------------

  private async _handleSttUpload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > MAX_STT_FILE_SIZE) {
      IcToast.show("File exceeds 25MB limit", "error");
      input.value = "";
      return;
    }

    this._processing = true;
    this._sttResult = null;

    try {
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const res = await this.rpcClient.call("media.test.stt", {
        audio: base64,
        mimeType: file.type || "audio/wav",
      }) as SttTestResult;
      this._sttResult = res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      IcToast.show(`STT failed: ${msg}`, "error");
    } finally {
      this._processing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // TTS
  // ---------------------------------------------------------------------------

  private async _handleTtsSynthesize(): Promise<void> {
    if (!this._ttsText.trim()) return;

    this._processing = true;
    this._ttsResult = null;

    // Clean up previous audio URL
    if (this._audioUrl) {
      URL.revokeObjectURL(this._audioUrl);
      this._audioUrl = null;
    }

    try {
      const res = await this.rpcClient.call("media.test.tts", {
        text: this._ttsText,
        voice: this._ttsVoice || undefined,
      }) as TtsTestResult;
      this._ttsResult = res;

      // Convert base64 to object URL for audio playback
      const binary = atob(res.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: res.mimeType });
      this._audioUrl = URL.createObjectURL(blob);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      IcToast.show(`TTS failed: ${msg}`, "error");
    } finally {
      this._processing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Vision
  // ---------------------------------------------------------------------------

  private async _handleVisionUpload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > MAX_VISION_FILE_SIZE) {
      IcToast.show("File exceeds 20MB limit", "error");
      input.value = "";
      return;
    }

    // Clean up previous image preview
    if (this._imagePreviewUrl) {
      URL.revokeObjectURL(this._imagePreviewUrl);
    }
    this._imagePreviewUrl = URL.createObjectURL(file);

    this._processing = true;
    this._visionResult = null;
    this.requestUpdate();

    try {
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const res = await this.rpcClient.call("media.test.vision", {
        image: base64,
        mimeType: file.type || "image/jpeg",
        prompt: this._visionPrompt || undefined,
      }) as VisionTestResult;
      this._visionResult = res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      IcToast.show(`Vision analysis failed: ${msg}`, "error");
    } finally {
      this._processing = false;
      input.value = "";
    }
  }

  // ---------------------------------------------------------------------------
  // Document
  // ---------------------------------------------------------------------------

  private async _handleDocumentUpload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > MAX_DOC_VIDEO_FILE_SIZE) {
      IcToast.show("File exceeds 50MB limit", "error");
      input.value = "";
      return;
    }

    this._processing = true;
    this._documentResult = null;

    try {
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const res = await this.rpcClient.call("media.test.document", {
        file: base64,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name,
      }) as DocumentTestResult;
      this._documentResult = res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      IcToast.show(`Document extraction failed: ${msg}`, "error");
    } finally {
      this._processing = false;
      input.value = "";
    }
  }

  // ---------------------------------------------------------------------------
  // Video
  // ---------------------------------------------------------------------------

  private async _handleVideoUpload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > MAX_DOC_VIDEO_FILE_SIZE) {
      IcToast.show("File exceeds 50MB limit", "error");
      input.value = "";
      return;
    }

    this._processing = true;
    this._videoResult = null;

    try {
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const res = await this.rpcClient.call("media.test.video", {
        video: base64,
        mimeType: file.type || "video/mp4",
        prompt: this._videoPrompt || undefined,
      }) as VideoTestResult;
      this._videoResult = res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      IcToast.show(`Video analysis failed: ${msg}`, "error");
    } finally {
      this._processing = false;
      input.value = "";
    }
  }

  // ---------------------------------------------------------------------------
  // Link
  // ---------------------------------------------------------------------------

  private async _handleLinkTest(): Promise<void> {
    if (!this._linkUrl.trim()) return;

    this._processing = true;
    this._linkResult = null;

    try {
      const res = await this.rpcClient.call("media.test.link", {
        url: this._linkUrl,
      }) as LinkTestResult;
      this._linkResult = res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      IcToast.show(`Link processing failed: ${msg}`, "error");
    } finally {
      this._processing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private _renderSttProviderInfo() {
    if (this._providers === null) {
      return html`<div class="provider-info">Provider info unavailable</div>`;
    }
    if (!this._providers.stt) {
      return html`<div class="provider-info warning">STT not configured -- set integrations.media.transcription in config</div>`;
    }
    const s = this._providers.stt;
    return html`<div class="provider-info">Provider: ${s.provider}${s.model ? ` (${s.model})` : ""}</div>`;
  }

  private _renderTtsProviderInfo() {
    if (this._providers === null) {
      return html`<div class="provider-info">Provider info unavailable</div>`;
    }
    if (!this._providers.tts) {
      return html`<div class="provider-info warning">TTS not configured -- set integrations.media.tts in config</div>`;
    }
    const t = this._providers.tts;
    return html`<div class="provider-info">Provider: ${t.provider}, Voice: ${t.voice}, Format: ${t.format}</div>`;
  }

  private _renderSttTab() {
    return html`
      <div class="card">
        <div class="card-title">Speech-to-Text</div>
        ${this._renderSttProviderInfo()}
        <div class="file-input-wrapper">
          <label class="file-label">Upload audio file</label>
          <input
            type="file"
            accept="audio/*,.wav,.mp3,.ogg,.m4a,.webm,.flac"
            @change=${this._handleSttUpload}
            ?disabled=${this._processing}
          />
          <div class="file-hint">Max 25MB</div>
        </div>
        ${this._processing ? html`
          <div class="spinner-inline">
            <ic-loading></ic-loading>
            Transcribing...
          </div>
        ` : nothing}
        ${this._sttResult ? html`
          <div class="result-box">
            <div class="result-label">Transcription</div>
            <pre class="result-text">${this._sttResult.text}</pre>
            <div class="result-meta">
              ${this._sttResult.language ? html`<span>Language: ${this._sttResult.language}</span>` : nothing}
              ${this._sttResult.durationMs ? html`<span>Duration: ${this._sttResult.durationMs}ms</span>` : nothing}
              <span>Provider: ${this._sttResult.provider}</span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _renderTtsTab() {
    return html`
      <div class="card">
        <div class="card-title">Text-to-Speech</div>
        ${this._renderTtsProviderInfo()}
        <div class="input-group">
          <label class="input-label">Text to synthesize</label>
          <textarea
            placeholder="Enter text to synthesize..."
            .value=${this._ttsText}
            @input=${(e: InputEvent) => { this._ttsText = (e.target as HTMLTextAreaElement).value; }}
            ?disabled=${this._processing}
          ></textarea>
        </div>
        <div class="input-group">
          <label class="input-label">Voice override (optional)</label>
          <input
            class="text-input"
            type="text"
            placeholder="Leave empty for default"
            .value=${this._ttsVoice}
            @input=${(e: InputEvent) => { this._ttsVoice = (e.target as HTMLInputElement).value; }}
            ?disabled=${this._processing}
          />
        </div>
        <button
          class="btn-primary"
          @click=${this._handleTtsSynthesize}
          ?disabled=${this._processing || !this._ttsText.trim()}
        >
          Synthesize
        </button>
        ${this._processing ? html`
          <div class="spinner-inline">
            <ic-loading></ic-loading>
            Synthesizing...
          </div>
        ` : nothing}
        ${this._audioUrl && this._ttsResult ? html`
          <div class="audio-player">
            <audio controls src=${this._audioUrl}></audio>
            <div class="result-meta">
              <span>Size: ${(this._ttsResult.sizeBytes / 1024).toFixed(1)} KB</span>
              <span>Format: ${this._ttsResult.mimeType}</span>
              <span>Provider: ${this._ttsResult.provider}</span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _renderVisionProviderInfo() {
    if (this._providers === null) {
      return html`<div class="provider-info">Provider info unavailable</div>`;
    }
    if (!this._providers.vision) {
      return html`<div class="provider-info warning">Vision not configured -- set integrations.media.vision in config</div>`;
    }
    const v = this._providers.vision;
    return html`<div class="provider-info">
      Providers: ${v.providers.join(", ")}${v.defaultProvider ? ` (default: ${v.defaultProvider})` : ""}
    </div>`;
  }

  private _renderDocumentProviderInfo() {
    if (this._providers === null) {
      return html`<div class="provider-info">Provider info unavailable</div>`;
    }
    if (!this._providers.documentExtraction?.enabled) {
      return html`<div class="provider-info warning">Document extraction not configured -- set integrations.media.documentExtraction in config</div>`;
    }
    return html`<div class="provider-info">Document extraction enabled</div>`;
  }

  private _renderVideoProviderInfo() {
    if (this._providers === null) {
      return html`<div class="provider-info">Provider info unavailable</div>`;
    }
    const v = this._providers.vision;
    if (!v?.videoCapable?.length) {
      return html`<div class="provider-info warning">No video-capable vision provider configured (requires Gemini or compatible)</div>`;
    }
    return html`<div class="provider-info">Video-capable providers: ${v.videoCapable.join(", ")}</div>`;
  }

  private _renderVisionTab() {
    return html`
      <div class="card">
        <div class="card-title">Vision Analysis</div>
        ${this._renderVisionProviderInfo()}
        <div class="file-input-wrapper">
          <label class="file-label">Upload image</label>
          <input
            type="file"
            accept="image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp"
            @change=${this._handleVisionUpload}
            ?disabled=${this._processing}
          />
          <div class="file-hint">Max 20MB</div>
        </div>
        <div class="input-group">
          <label class="input-label">Analysis prompt (optional)</label>
          <textarea
            placeholder="Describe this image in detail"
            .value=${this._visionPrompt}
            @input=${(e: InputEvent) => { this._visionPrompt = (e.target as HTMLTextAreaElement).value; }}
            ?disabled=${this._processing}
          ></textarea>
        </div>
        ${this._processing ? html`
          <div class="spinner-inline">
            <ic-loading></ic-loading>
            Analyzing image...
          </div>
        ` : nothing}
        ${this._imagePreviewUrl ? html`
          <div class="image-preview">
            <img src=${this._imagePreviewUrl} alt="Upload preview" />
          </div>
        ` : nothing}
        ${this._visionResult ? html`
          <div class="result-box">
            <div class="result-label">Analysis</div>
            <pre class="result-text">${this._visionResult.description}</pre>
            <div class="result-meta">
              <span>Provider: ${this._visionResult.provider}</span>
              <span>Model: ${this._visionResult.model}</span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _renderDocumentTab() {
    return html`
      <div class="card">
        <div class="card-title">Document Extraction</div>
        ${this._renderDocumentProviderInfo()}
        <div class="file-input-wrapper">
          <label class="file-label">Upload document</label>
          <input
            type="file"
            accept=".pdf,.csv,.txt,.json,.xml,.html,.md,.doc,.docx,.xls,.xlsx"
            @change=${this._handleDocumentUpload}
            ?disabled=${this._processing}
          />
          <div class="file-hint">Max 50MB</div>
        </div>
        ${this._processing ? html`
          <div class="spinner-inline">
            <ic-loading></ic-loading>
            Extracting text...
          </div>
        ` : nothing}
        ${this._documentResult ? html`
          <div class="result-box">
            <div class="result-label">Extracted Text</div>
            <pre class="result-text result-text--scrollable">${this._documentResult.text}</pre>
            <div class="result-meta">
              <span>File: ${this._documentResult.fileName}</span>
              <span>Chars: ${this._documentResult.extractedChars.toLocaleString()}</span>
              ${this._documentResult.pageCount != null ? html`<span>Pages: ${this._documentResult.pageCount}</span>` : nothing}
              ${this._documentResult.truncated ? html`<span class="truncated-badge">Truncated</span>` : nothing}
              <span>Duration: ${this._documentResult.durationMs}ms</span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _renderVideoTab() {
    return html`
      <div class="card">
        <div class="card-title">Video Analysis</div>
        ${this._renderVideoProviderInfo()}
        <div class="file-input-wrapper">
          <label class="file-label">Upload video</label>
          <input
            type="file"
            accept="video/*,.mp4,.mov,.avi,.webm,.mkv"
            @change=${this._handleVideoUpload}
            ?disabled=${this._processing}
          />
          <div class="file-hint">Max 50MB</div>
        </div>
        <div class="input-group">
          <label class="input-label">Analysis prompt (optional)</label>
          <textarea
            placeholder="Describe this video concisely."
            .value=${this._videoPrompt}
            @input=${(e: InputEvent) => { this._videoPrompt = (e.target as HTMLTextAreaElement).value; }}
            ?disabled=${this._processing}
          ></textarea>
        </div>
        ${this._processing ? html`
          <div class="spinner-inline">
            <ic-loading></ic-loading>
            Analyzing video...
          </div>
        ` : nothing}
        ${this._videoResult ? html`
          <div class="result-box">
            <div class="result-label">Analysis</div>
            <pre class="result-text">${this._videoResult.description}</pre>
            <div class="result-meta">
              <span>Provider: ${this._videoResult.provider}</span>
              <span>Model: ${this._videoResult.model}</span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Link
  // ---------------------------------------------------------------------------

  private _renderLinkProviderInfo() {
    if (this._providers === null) {
      return html`<div class="provider-info">Provider info unavailable</div>`;
    }
    if (this._providers.linkUnderstanding?.enabled) {
      return html`<div class="provider-info">Link enrichment enabled (max ${this._providers.linkUnderstanding.maxLinks} links)</div>`;
    }
    return html`<div class="provider-info warning">Link understanding not configured</div>`;
  }

  private _renderLinkTab() {
    return html`
      <div class="card">
        <div class="card-title">Link Enrichment</div>
        ${this._renderLinkProviderInfo()}
        <div class="input-group">
          <label class="input-label">Enter URL to process</label>
          <input
            class="text-input"
            type="url"
            placeholder="https://example.com/article"
            .value=${this._linkUrl}
            @input=${(e: InputEvent) => { this._linkUrl = (e.target as HTMLInputElement).value; }}
            ?disabled=${this._processing}
          />
        </div>
        <button
          class="btn-primary"
          @click=${this._handleLinkTest}
          ?disabled=${this._processing || !this._linkUrl.trim()}
        >
          Process Link
        </button>
        ${this._processing ? html`
          <div class="spinner-inline">
            <ic-loading></ic-loading>
            Processing link...
          </div>
        ` : nothing}
        ${this._linkResult ? html`
          <div class="result-box">
            <div class="result-label">Enriched Text</div>
            <pre class="result-text result-text--scrollable">${this._linkResult.enrichedText}</pre>
            <div class="result-meta">
              <span>Links processed: ${this._linkResult.linksProcessed}</span>
            </div>
            ${this._linkResult.errors.length > 0 ? html`
              <div class="provider-info warning" style="margin-top: var(--ic-space-sm);">
                Errors: ${this._linkResult.errors.join(", ")}
              </div>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _renderActiveTab() {
    switch (this._activeTab) {
      case "stt": return this._renderSttTab();
      case "tts": return this._renderTtsTab();
      case "vision": return this._renderVisionTab();
      case "document": return this._renderDocumentTab();
      case "video": return this._renderVideoTab();
      case "link": return this._renderLinkTab();
      default: return nothing;
    }
  }

  override render() {
    return html`
      <div class="header-row">
        <div class="header-title">Media Tools</div>
      </div>
      <ic-tabs
        .tabs=${TABS}
        .activeTab=${this._activeTab}
        @tab-change=${(e: CustomEvent<string>) => { this._activeTab = e.detail; }}
      >
      </ic-tabs>
      <div class="tab-content">
        ${this._renderActiveTab()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-media-test-view": IcMediaTestView;
  }
}
