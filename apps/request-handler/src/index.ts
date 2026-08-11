import express from "express";
import { S3 } from "@aws-sdk/client-s3";
import { contentTypeFor } from "./mime";
import { createS3Client, s3Bucket } from "@vercel-clone/shared";


const app = express();

export const BUCKET = s3Bucket();

const s3 = createS3Client();

interface Fetched {
  body: Buffer;
  key: string;
}

// Returns null for a missing object; throws for anything else, so "not found"
// and "the store is broken" stay distinguishable.
async function fetchObject(key: string): Promise<Fetched | null> {
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: key });
    if (!obj.Body) return null;
    return { body: Buffer.from(await obj.Body.transformToByteArray()), key };
  } catch (e) {
    const name = (e as { name?: string }).name;
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === "NoSuchKey" || name === "NotFound" || status === 404) return null;
    throw e;
  }
}

// A SPA owns its client-side routes, so /about must serve the shell. But an asset
// that 404s must stay a 404 — returning HTML with status 200 turns a broken script
// tag into a confusing MIME error instead of a visible missing file.
function wantsSpaShell(req: express.Request, filePath: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!(req.headers.accept ?? "").includes("text/html")) return false;
  const lastSegment = filePath.split("/").pop() ?? "";
  return !lastSegment.includes(".");
}

// Express 5 needs a NAMED wildcard, and the braces make it match zero segments too:
// "/*splat" alone does NOT match "/", which sends the site root to Express's 404.
app.get("/{*splat}", async (req, res) => {
  const id = req.hostname.split(".")[0];

  // The root is not a fallback case: "dist/{id}/" matches no object because the
  // keyspace is flat and has no directory entries.
  const filePath = req.path === "/" ? "/index.html" : req.path;

  if (filePath.includes("..")) {
    res.status(400).send("Bad request");
    return;
  }

  try {
    let found = await fetchObject(`dist/${id}${filePath}`);
    let servedPath = filePath;

    if (!found && wantsSpaShell(req, filePath)) {
      found = await fetchObject(`dist/${id}/index.html`);
      servedPath = "/index.html";
    }

    if (!found) {
      res.status(404).send("Not found");
      return;
    }

    res.set("Content-Type", contentTypeFor(servedPath));
    // Safe only now that the map above is correct: it stops the browser
    // second-guessing a type we got right.
    res.set("X-Content-Type-Options", "nosniff");
    res.send(found.body);
  } catch (e) {
    // A broken bucket is not a missing page — say so, and log enough to debug.
    console.error(`502 serving dist/${id}${filePath}:`, e instanceof Error ? e.message : e);
    res.status(502).send("Upstream storage error");
  }
});


app.listen(3001, () => console.log("request handler listening on http://localhost:3001"));
