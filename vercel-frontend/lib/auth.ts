import { betterAuth } from "better-auth";
import { Pool } from "pg";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Set it in vercel-frontend/.env`);
  }
  return value;
}

// Better Auth keeps its user/session/account tables in the same Neon database the
// deployment records live in, so there is one store to back up and one to query.
export const auth = betterAuth({
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
