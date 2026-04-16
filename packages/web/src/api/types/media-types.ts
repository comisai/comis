/**
 * Media domain types.
 *
 * Interfaces for speech-to-text, text-to-speech, vision analysis,
 * document extraction, and media provider configuration.
 */

/** Speech-to-text transcription result */
export interface SttResult {
  readonly text: string;
  readonly provider: string;
  readonly durationMs: number;
  readonly confidence?: number;
}

/** Text-to-speech request parameters */
export interface TtsRequest {
  readonly text: string;
  readonly provider?: string;
  readonly voice?: string;
}

/** Vision analysis result */
export interface VisionResult {
  readonly description: string;
  readonly provider: string;
  readonly labels?: string[];
}

/** Document text extraction result */
export interface DocumentExtractionResult {
  readonly text: string;
  readonly pages?: number;
  readonly format: string;
}

/** Media provider configuration entry */
export interface MediaProviderConfig {
  readonly type: "stt" | "tts" | "vision";
  readonly provider: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Media Test Result Types
// ---------------------------------------------------------------------------

/** STT test result from media.test.stt */
export interface SttTestResult {
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
  readonly provider: string;
}

/** TTS test result from media.test.tts (base64 audio for browser playback) */
export interface TtsTestResult {
  readonly audio: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly provider: string;
}

/** Vision test result from media.test.vision */
export interface VisionTestResult {
  readonly description: string;
  readonly provider: string;
  readonly model: string;
}

/** Document extraction test result from media.test.document */
export interface DocumentTestResult {
  readonly text: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly extractedChars: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly pageCount?: number;
}

/** Video analysis test result from media.test.video */
export interface VideoTestResult {
  readonly description: string;
  readonly provider: string;
  readonly model: string;
}

/** Link enrichment test result from media.test.link */
export interface LinkTestResult {
  readonly enrichedText: string;
  readonly linksProcessed: number;
  readonly errors: string[];
}

/** Provider availability from media.providers */
export interface MediaProvidersInfo {
  readonly stt: { provider: string; model?: string; fallback: string[] } | null;
  readonly tts: { provider: string; voice: string; format: string; autoMode: string } | null;
  readonly vision: { providers: string[]; defaultProvider?: string; videoCapable: string[] } | null;
  readonly documentExtraction: { enabled: boolean; supportedMimes: string[] } | null;
  readonly linkUnderstanding: { enabled: boolean; maxLinks: number } | null;
}
