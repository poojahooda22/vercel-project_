import type { Request, Response } from "express";
import { sql } from "./db";

/**
 * Cookie names Better Auth may use, in the order it checks them itself
 * (better-auth/dist/cookies/index.mjs, getSessionCookie):
 *
 *   const getCookie = (name) => parsedCookie.get(`__Secure-${name}`) ?? parsedCookie.get(name);
 *   getCookie(`${cookiePrefix}.${cookieName}`) || getCookie(`${cookiePrefix}-${cookieName}`)
 *
 * The `__Secure-` variants are what actually arrive over HTTPS, so checking only the
 * plain name would work in local dev and fail the moment this is deployed.
 */
const COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
  "__Secure-better-auth-session_token",
  "better-auth-session_token",
];

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Pulls the session token out of the request.
 *
 * The cookie value is NOT the token — it is `<token>.<hmac signature>`, verified
 * against a real Set-Cookie from this app:
 *
 *   better-auth.session_token=JsvBP0...Ik0J.HgWHMP...OGU%3D
 *
 * and only the part before the first "." exists in the session table. Looking the
 * whole cookie value up returns nothing, every time.
 */
function tokenFromRequest(req: Request): string | null {
  const header = req.headers.cookie;
  for (const name of COOKIE_NAMES) {
    const raw = readCookie(header, name);
    if (raw) return raw.split(".")[0] ?? null;
  }
  return null;
}

/**
 * The signature is deliberately not re-verified here.
 *
 * It exists so Better Auth can reject a tampered cookie without touching the
 * database. We hit the database anyway, and the token is 32 random characters —
 * an attacker who can produce a row-matching token already holds a valid session,
 * so checking the HMAC would reject nothing the lookup does not already reject.
 * Re-implementing its exact scheme would also couple this service to Better Auth's
 * internals across versions.
 */
export async function getUserId(req: Request): Promise<string | null> {
  const token = tokenFromRequest(req);
  if (!token) return null;

  const rows = await sql`
    SELECT "userId" FROM "session"
     WHERE token = ${token} AND "expiresAt" > now()
     LIMIT 1
  `;
  return (rows[0]?.userId as string) ?? null;
}

/**
 * Route guard. Returns the user id, or answers 401 and returns null — so callers
 * read as: `const userId = await requireUser(req, res); if (!userId) return;`
 */
export async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "not signed in" });
    return null;
  }
  return userId;
}
