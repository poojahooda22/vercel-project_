"use client";

import { useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { screenshotUrl, type Deployment } from "@/lib/deployments";

/** How long after a build finishes we still describe a missing shot as "coming". */
const CAPTURE_GRACE_MS = 3 * 60_000;

function awaitingCapture(d: Deployment): boolean {
  if (d.state !== "deployed" || d.screenshot_at) return false;
  const finished = d.finished_at ? new Date(d.finished_at).getTime() : 0;
  return Date.now() - finished < CAPTURE_GRACE_MS;
}

/**
 * The deployment's preview image.
 *
 * `screenshot_at` is the source of truth for whether one exists, but the <img> can
 * still fail — the object could have been swept, or the upload service could be
 * down — so a broken image falls back to the placeholder instead of showing the
 * browser's default broken-image glyph.
 */
export function Screenshot({
  deployment: d,
  className = "aspect-[4/3]",
}: {
  deployment: Deployment;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = `${className} relative overflow-hidden rounded-md border border-secondary bg-background`;

  if (d.screenshot_at && !failed) {
    return (
      <div className={box}>
        {/* Plain <img>: next/image would need every deployment host registered in
            next.config, and this is one same-origin JPEG with an immutable URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={screenshotUrl(d.id)}
          alt={`Screenshot of ${d.id}`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-full object-cover object-top"
        />
      </div>
    );
  }

  return (
    <div className={`${box} flex items-center justify-center`}>
      {awaitingCapture(d) ? (
        <span className="inline-flex items-center gap-md text-sm text-foreground-placeholder">
          <Loader2 className="size-4 animate-spin" />
          Capturing preview…
        </span>
      ) : (
        <span className="inline-flex items-center gap-md text-sm text-foreground-placeholder">
          <ImageOff className="size-4" />
          No screenshot
        </span>
      )}
    </div>
  );
}
