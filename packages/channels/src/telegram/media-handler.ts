// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import type { Message, PhotoSize, Document, Voice, Video, VideoNote } from "grammy/types";

/**
 * Build a tg-file:// URI for deferred media resolution.
 * The adapter will resolve these to actual download URLs when needed.
 */
function tgFileUri(fileId: string): string {
  return `tg-file://${fileId}`;
}

/**
 * Extract the largest photo from a Telegram photo array.
 * Telegram sends multiple sizes; the last element is always the largest.
 */
function extractPhoto(photos: PhotoSize[]): Attachment {
  const largest = photos[photos.length - 1];
  return {
    type: "image",
    url: tgFileUri(largest.file_id),
  };
}

/**
 * Extract attachment metadata from a Telegram document.
 */
function extractDocument(doc: Document): Attachment {
  return {
    type: "file",
    url: tgFileUri(doc.file_id),
    ...(doc.mime_type != null && { mimeType: doc.mime_type }),
    ...(doc.file_name != null && { fileName: doc.file_name }),
    ...(doc.file_size != null && { sizeBytes: doc.file_size }),
  };
}

/**
 * Extract attachment metadata from a Telegram voice message.
 */
function extractVoice(voice: Voice): Attachment {
  return {
    type: "audio",
    url: tgFileUri(voice.file_id),
    mimeType: voice.mime_type ?? "audio/ogg",
    isVoiceNote: true,
  };
}

/**
 * Extract attachment metadata from a Telegram video.
 */
function extractVideo(video: Video): Attachment {
  return {
    type: "video",
    url: tgFileUri(video.file_id),
    ...(video.mime_type != null && { mimeType: video.mime_type }),
  };
}

/**
 * Extract attachment metadata from a Telegram video note (round video message).
 */
function extractVideoNote(videoNote: VideoNote): Attachment {
  return {
    type: "video",
    url: tgFileUri(videoNote.file_id),
    mimeType: "video/mp4",
    durationMs: videoNote.duration * 1000,
    isVoiceNote: true,
  };
}

/**
 * Build an array of Attachment objects from a Grammy Message.
 *
 * Handles: photo, document, voice, video, video_note.
 * Returns an empty array if no media is present.
 *
 * Note: A single Telegram message can only contain one media type
 * (except animation which also sets document). We check all types
 * and collect any that are present.
 */
export function buildAttachments(msg: Message): Attachment[] {
  const attachments: Attachment[] = [];

  if (msg.photo != null && msg.photo.length > 0) {
    attachments.push(extractPhoto(msg.photo));
  }

  if (msg.document != null) {
    attachments.push(extractDocument(msg.document));
  }

  if (msg.voice != null) {
    attachments.push(extractVoice(msg.voice));
  }

  if (msg.video != null) {
    attachments.push(extractVideo(msg.video));
  }

  if (msg.video_note != null) {
    attachments.push(extractVideoNote(msg.video_note));
  }

  return attachments;
}
