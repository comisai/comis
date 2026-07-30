import { basename, extname } from "node:path";

const MIME_BY_EXTENSION = new Map([
  [".csv", "text/csv"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".xml", "text/xml"],
  [".yaml", "text/yaml"],
  [".yml", "text/yaml"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export function mediaMetaForPath(filePath) {
  const fileName = basename(filePath);
  const mimeType = MIME_BY_EXTENSION.get(extname(fileName).toLowerCase());
  return {
    fileName,
    ...(mimeType ? { mimeType } : {}),
  };
}
