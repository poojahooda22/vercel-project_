import path from "path";

// Browsers dispatch on the MIME type, not the file extension, so a wrong type
// here means the asset does not render even though it downloaded fine.
// Types from developer.mozilla.org/en-US/docs/Web/HTTP/MIME_types.
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  // MDN: text/javascript is "the only MIME type guaranteed to work now and into
  // the future"; application/javascript is legacy.
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

// Unknown types fall back to octet-stream, which browsers download rather than
// execute. The old ternary fell back to a script type, which is the unsafe way round.
export function contentTypeFor(filePath: string): string {
  return TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
