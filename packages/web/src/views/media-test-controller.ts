// SPDX-License-Identifier: Apache-2.0
/**
 * Media test controller.
 *
 * Thin RPC façade — the media-test view retains @state for the
 * 6 tab content panels (STT / TTS / Vision / Document / Video /
 * Link), the in-flight `_processing` flag, audio playback URL
 * lifecycle, and image-preview Object URL because the existing
 * file-upload + browser audio playback + IcToast surfacing flows
 * keep state on the view. The controller's job is to keep
 * `rpcClient.call(...)` out of `media-test.ts`.
 *
 * Controller cap is 600L (tighter than the default 900) —
 * media-test is a test-harness with a small RPC surface (7 methods,
 * one per tab + capabilities probe).
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type {
  SttTestResult,
  TtsTestResult,
  VisionTestResult,
  DocumentTestResult,
  VideoTestResult,
  LinkTestResult,
  MediaProvidersInfo,
} from "../api/types/media-types.js";

/* ------------------------------------------------------------------ */
/*  RPC arg + response shapes                                          */
/* ------------------------------------------------------------------ */

export interface SttTestArgs {
  audio: string;
  mimeType: string;
}

export interface TtsTestArgs {
  text: string;
  voice?: string;
}

export interface VisionTestArgs {
  image: string;
  mimeType: string;
  prompt?: string;
}

export interface DocumentTestArgs {
  file: string;
  mimeType: string;
  fileName: string;
}

export interface VideoTestArgs {
  video: string;
  mimeType: string;
  prompt?: string;
}

export interface LinkTestArgs {
  url: string;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface MediaTestController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Probe provider availability (media.providers). May degrade
   *  gracefully — handler may not exist on the daemon. */
  getProviders(): Promise<MediaProvidersInfo>;
  /** Run the STT transcription harness (media.test.stt). */
  testStt(args: SttTestArgs): Promise<SttTestResult>;
  /** Run the TTS synthesis harness (media.test.tts). */
  testTts(args: TtsTestArgs): Promise<TtsTestResult>;
  /** Run the vision analysis harness (media.test.vision). */
  testVision(args: VisionTestArgs): Promise<VisionTestResult>;
  /** Run the document extraction harness (media.test.document). */
  testDocument(args: DocumentTestArgs): Promise<DocumentTestResult>;
  /** Run the video analysis harness (media.test.video). */
  testVideo(args: VideoTestArgs): Promise<VideoTestResult>;
  /** Run the link processing harness (media.test.link). */
  testLink(args: LinkTestArgs): Promise<LinkTestResult>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createMediaTestController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): MediaTestController {
  const controller: MediaTestController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages audio + image Object URL teardown */
    },

    getProviders(): Promise<MediaProvidersInfo> {
      return rpcClient.call<MediaProvidersInfo>("media.providers");
    },

    testStt(args: SttTestArgs): Promise<SttTestResult> {
      return rpcClient.call<SttTestResult>("media.test.stt", args);
    },

    testTts(args: TtsTestArgs): Promise<TtsTestResult> {
      return rpcClient.call<TtsTestResult>("media.test.tts", args);
    },

    testVision(args: VisionTestArgs): Promise<VisionTestResult> {
      return rpcClient.call<VisionTestResult>("media.test.vision", args);
    },

    testDocument(args: DocumentTestArgs): Promise<DocumentTestResult> {
      return rpcClient.call<DocumentTestResult>("media.test.document", args);
    },

    testVideo(args: VideoTestArgs): Promise<VideoTestResult> {
      return rpcClient.call<VideoTestResult>("media.test.video", args);
    },

    testLink(args: LinkTestArgs): Promise<LinkTestResult> {
      return rpcClient.call<LinkTestResult>("media.test.link", args);
    },
  };

  host.addController(controller);
  return controller;
}
