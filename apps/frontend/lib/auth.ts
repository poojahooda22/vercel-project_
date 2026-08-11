import { betterAuth } from "better-auth";
import { Pool } from "pg";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Set it on the running container.`);
  }
  return value;
}

// Better Auth keeps its user/session/account tables in the same Neon database the
// deployment records live in, so there is one store to back up and one to query.
function createAuth() {
  return betterAuth({
    database: new Pool({ connectionString: required("NEON_DB") }),
    secret: required("BETTER_AUTH_SECRET"),
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3002",
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      github: {
        clientId: required("GITHUB_CLIENT_ID"),
        clientSecret: required("GITHUB_CLIENT_SECRET"),
      },
      google: {
        clientId: required("GOOGLE_CLIENT_ID"),
        clientSecret: required("GOOGLE_CLIENT_SECRET"),
      },
    },
  });
}

// Built on first use, NOT at import time.
//
// `next build` imports every route module to collect its page data, so anything
// evaluated at module scope runs during the build — inside an image build that has
// no secrets, by design. Calling betterAuth() at module scope made required() throw
// there and failed the build with "Failed to collect page data for /api/auth/[...all]".
//
// Deferring construction keeps the validation exactly as strict — a missing variable
// still throws loudly, on the first request instead of at import — while letting the
// image build with no configuration at all. Configuration belongs to the container
// that runs the image, not to the image.
//
// The inferred return type of createAuth is used rather than ReturnType<typeof
// betterAuth>: betterAuth is generic over its options, so naming it directly would
// instantiate the constraint default and widen away the plugin/provider types.
let instance: ReturnType<typeof createAuth> | null = null;

export function getAuth(): ReturnType<typeof createAuth> {
  instance ??= createAuth();
  return instance;
}
