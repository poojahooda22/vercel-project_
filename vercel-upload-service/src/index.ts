import express from "express";
import cors from "cors";
import { createClient } from "redis";
import { generate } from "./utils";
import simpleGit from "simple-git";
import { getAllFiles } from "./file";
import path from "path";
import { deletePrefix, getObjectBytes, uploadFile } from "./aws";
import { requireUser } from "./session";
import {
  createDeployment,
  deleteDeployment,
  failQueued,
  getDeployment,
  listDeployments,
} from "./db";

const publisher = createClient();
publisher.on("error", (err) => console.error("Redis client error", err));

const app = express();

// The dashboard sends its session cookie, so the origin cannot be "*": the CORS
// spec forbids credentials with a wildcard origin, and browsers drop the response.
// In production the dashboard and this API share an origin behind Caddy and none of
// this applies — it exists for local dev, where they are :3002 and :3000.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3002";
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

app.post("/deploy", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const repoUrl = req.body?.repoUrl;
  if (typeof repoUrl !== "string" || !repoUrl) {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }

  const id = generate();

  // Reserving the row is also the collision check — an id already in use returns
  // false here instead of overwriting someone else's deployment.
  if (!(await createDeployment(id, repoUrl, userId))) {
    res.status(409).json({ error: "id collision, retry" });
    return;
  }

  try {
    await simpleGit().clone(repoUrl, path.resolve(__dirname, `output/${id}`));

    const files = getAllFiles(path.resolve(__dirname, `output/${id}`));

    // An object key is a wire string and must use "/". Slicing a local path leaves
    // Windows "\" in the key, which R2 stores as a flat filename instead of a folder.
    await Promise.all(
      files.map((file) =>
        uploadFile(file.slice(__dirname.length + 1).split(path.sep).join("/"), file)
      )
    );
  } catch (e) {
    // A bad repo URL is the caller's problem, not a crashed service.
    await failQueued(id, e instanceof Error ? e.message : String(e));
    res.status(400).json({ id, error: "clone or upload failed" });
    return;
  }

  // Enqueue only after every file is durably in the bucket: the queue message is
  // a pointer, and publishing it early makes the worker build a partial tree.
  //
  // This needs its own catch. Unguarded, a Redis outage escapes to Express's
  // default error handler, which answers an HTML page — the caller asked for JSON
  // and gets "Unexpected token '<'", which says nothing about Redis. Worse, the
  // row stays 'queued' with no worker coming for it and no reason recorded.
  try {
    await publisher.lPush("build-queue", id);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await failQueued(id, `could not enqueue build: ${reason}`);
    res.status(503).json({
      id,
      error: "queue unavailable — files uploaded but the build was not scheduled",
      detail: reason,
    });
    return;
  }

  res.json({ id: id });
});

app.get("/status", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = req.query.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id query parameter is required" });
    return;
  }

  // Someone else's id is a 404, not a 403: telling the caller "exists but not yours"
  // turns this endpoint into an oracle for enumerating other tenants' deployments.
  const deployment = await getDeployment(id, userId);
  if (!deployment) {
    res.status(404).json({ error: "no such deployment" });
    return;
  }

  res.json({
    id: deployment.id,
    status: deployment.state,
    repoUrl: deployment.repo_url,
    error: deployment.error_message,
    createdAt: deployment.created_at,
    finishedAt: deployment.finished_at,
  });
});

app.get("/deployments", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  res.json({ deployments: await listDeployments(userId) });
});

// Deliberately PUBLIC, unlike every other route here. The deployment it pictures is
// already served to anyone at {id}.<domain>, so requiring a session to see the
// screenshot would protect nothing while breaking <img> tags, which cannot carry
// credentials as simply as fetch can.
app.get("/screenshot/:id", async (req, res) => {
  const { id } = req.params;

  // The id becomes an object key, so anything path-like has to be rejected before
  // it reaches R2 rather than sanitised afterwards.
  if (!/^[a-z0-9]+$/i.test(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  try {
    const image = await getObjectBytes(`screenshots/${id}.jpg`);
    if (!image) {
      res.status(404).json({ error: "no screenshot" });
      return;
    }

    res.set("Content-Type", "image/jpeg");
    res.set("X-Content-Type-Options", "nosniff");
    // A deployment id maps to one immutable build, so its screenshot can never
    // change: the browser should never ask for it twice.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(image);
  } catch (e) {
    console.error(`502 serving screenshots/${id}.jpg:`, e instanceof Error ? e.message : e);
    res.status(502).send("Upstream storage error");
  }
});

app.delete("/deployments/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const { id } = req.params;

  // ROW FIRST — this is a reversal of the original order, and the reason matters.
  //
  // It used to sweep R2 first, so that a failed object delete could not orphan
  // files nobody references. That was the right trade while one person owned every
  // deployment: the worst case was paying for a few stray objects.
  //
  // With owners, sweeping first means any signed-in user could pass someone else's
  // id and destroy their site's files BEFORE the ownership check ever ran — the
  // guarded DELETE would then correctly refuse, long after the damage. Deleting the
  // row first makes this single statement both the authorization check and the
  // claim: no row, no sweep. The orphan risk returns, but leaked storage costs
  // pennies and is recoverable; another tenant's deleted site is neither.
  const removed = await deleteDeployment(id, userId);
  if (!removed) {
    res.status(404).json({ error: "no such deployment", objectsDeleted: 0 });
    return;
  }

  const staged = await deletePrefix(`output/${id}/`);
  const built = await deletePrefix(`dist/${id}/`);
  // The screenshot is a single object, not a folder, so it needs its own sweep —
  // "screenshots/{id}." keeps the prefix anchored to this id and cannot match
  // "screenshots/{id}2.jpg" the way a bare id would.
  const shots = await deletePrefix(`screenshots/${id}.`);

  res.json({ id, objectsDeleted: staged + built + shots });
});

async function main() {
  await publisher.connect();
  app.listen(3000);
}

main();
