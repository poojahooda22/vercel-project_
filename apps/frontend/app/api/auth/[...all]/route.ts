import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

// The handler is resolved per request rather than destructured at module scope.
//
// `export const { POST, GET } = toNextJsHandler(auth)` reads `auth` while the module
// is being evaluated, and `next build` evaluates every route module to collect its
// page data — so that form builds the auth instance (and demands every secret) at
// image-build time. Memoised here, so the construction still happens exactly once
// per process, just on the first request instead of during the build.
let handler: ReturnType<typeof toNextJsHandler> | null = null;

function resolve(): ReturnType<typeof toNextJsHandler> {
  handler ??= toNextJsHandler(getAuth());
  return handler;
}

export function POST(request: Request) {
  return resolve().POST(request);
}

export function GET(request: Request) {
  return resolve().GET(request);
}
