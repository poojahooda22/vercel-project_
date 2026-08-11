import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Gates the dashboard. Until this existed, `GET /` returned 200 and rendered
 * "Projects" with no cookies at all.
 *
 * `middleware.ts` is the pre-16 name for this file — Next 16 deprecated it and
 * renamed the convention to `proxy.ts`, exporting `proxy` instead of `middleware`
 * (node_modules/next/dist/docs/.../file-conventions/middleware.md).
 *
 * This is a UX redirect, NOT the security boundary. getSessionCookie only checks
 * that a session cookie is PRESENT — it does not validate the signature or look
 * the token up, so a forged cookie gets past it. That is fine and deliberate: the
 * real check runs in the upload service, where every query is scoped by the userId
 * resolved from the session table. Never move an authorization decision in here.
 */
export function proxy(request: NextRequest) {
  const hasSession = getSessionCookie(request);
  if (hasSession) return NextResponse.next();

  const login = new URL("/login", request.url);
  // So the user lands back where they were aiming after signing in.
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Without a matcher this runs on every request including static assets. Guard the
  // app surface only, and leave /login and Better Auth's own routes reachable —
  // gating /api/auth would make signing in impossible.
  matcher: ["/", "/projects/:path*", "/deployments/:path*"],
};
