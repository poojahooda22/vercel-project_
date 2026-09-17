import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub's delivery contract for the App's webhook (docs.github.com, webhooks):
 *   - the body is signed: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body)
 *   - compare in constant time; the header is absent when no secret is configured
 *   - payloads are capped at 25 MB (a push carries up to 2,048 commits with file lists)
 *   - answer 2xx within 10 seconds or the delivery is recorded as failed, and
 *     GitHub does NOT retry on its own — so the receiver records and enqueues,
 *     never clones
 *   - X-GitHub-Delivery is a GUID per delivery; a redelivery from GitHub's UI
 *     reuses it, which is what makes it usable for de-duplication
 *   - a delivery to a GitHub App carries `installation.id`: the installation the
 *     event is for, which is what scopes a push to one tenant's projects
 */

/** The header shapes GitHub sends; checked before a byte of body is read. */
export const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;
export const DELIVERY_RE = /^[A-Za-z0-9-]{1,64}$/;

export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  // Shape first: timingSafeEqual throws on unequal byte lengths, and a header of
  // the right character count but the wrong bytes must be a refusal, not a crash.
  if (!header || !SIGNATURE_RE.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(header.slice("sha256=".length), "utf8"), Buffer.from(expected, "utf8"));
}

/** The fields of a push event this platform reads (webhook-events-and-payloads#push). */
export interface PushEvent {
  /** "refs/heads/main" for a branch push, "refs/tags/…" for a tag. */
  ref: string;
  /** The commit at the tip after the push. */
  after: string;
  deleted: boolean;
  repository: { full_name: string; default_branch: string; private: boolean };
  /** The installation this delivery is for. Present on every delivery to a GitHub App. */
  installation?: { id: number };
}

export interface InstallationEvent {
  action: string;
  installation: { id: number };
}

/** The branch a push is for, or null when it is not a branch push (tags, deletions). */
export function pushedBranch(event: PushEvent): string | null {
  if (event.deleted) return null;
  const prefix = "refs/heads/";
  if (!event.ref.startsWith(prefix)) return null;
  return event.ref.slice(prefix.length);
}

export function isPushEvent(body: unknown): body is PushEvent {
  const b = body as Partial<PushEvent> | null;
  return (
    !!b &&
    typeof b.ref === "string" &&
    typeof b.after === "string" &&
    /^[0-9a-f]{40}$/.test(b.after) &&
    typeof b.deleted === "boolean" &&
    !!b.repository &&
    typeof b.repository.full_name === "string" &&
    typeof b.repository.default_branch === "string" &&
    typeof b.repository.private === "boolean" &&
    (b.installation === undefined || (!!b.installation && Number.isSafeInteger(b.installation.id)))
  );
}

export function isInstallationEvent(body: unknown): body is InstallationEvent {
  const b = body as Partial<InstallationEvent> | null;
  return !!b && typeof b.action === "string" && !!b.installation && Number.isSafeInteger(b.installation.id);
}
