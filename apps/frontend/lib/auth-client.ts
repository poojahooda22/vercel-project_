import { createAuthClient } from "better-auth/react";

// No baseURL: Better Auth then calls /api/auth/* on whatever origin the page was
// served from, which is always correct — localhost:3002 in `next dev`, and
// app.localhost behind Caddy, with no build-time value to keep in sync.
//
// It used to hardcode "http://localhost:3002" as a fallback. NEXT_PUBLIC_* values
// are inlined at BUILD time, so that string was compiled into the client bundle
// and shipped into the container, where the browser posted every sign-in to a port
// nothing listens on. Setting the variable would have papered over it; not needing
// one removes the class of bug.
export const authClient = createAuthClient(
  process.env.NEXT_PUBLIC_AUTH_URL ? { baseURL: process.env.NEXT_PUBLIC_AUTH_URL } : {}
);

export const { signIn, signUp, signOut, useSession } = authClient;
