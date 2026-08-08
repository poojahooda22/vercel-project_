import express from "express";
import cors from "cors";
import { createClient } from "redis";
import { generate } from "./utils";
import simpleGit from "simple-git";
import { getAllFiles } from "./file";
import path from "path";
import { deletePrefix, uploadFile } from "./aws";
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
app.use(cors());
app.use(express.json());

app.post("/deploy", async (req, res) => {
  const repoUrl = req.body?.repoUrl;
  if (typeof repoUrl !== "string" || !repoUrl) {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }

  const id = generate();

  // Reserving the row is also the collision check — an id already in use returns
  // false here instead of overwriting someone else's deployment.
  if (!(await createDeployment(id, repoUrl))) {
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
  await publisher.lPush("build-queue", id);

  res.json({ id: id });
});

app.get("/status", async (req, res) => {
  const id = req.query.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id query parameter is required" });
    return;
  }

  const deployment = await getDeployment(id);
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

app.get("/deployments", async (_req, res) => {
  res.json({ deployments: await listDeployments() });
});

app.delete("/deployments/:id", async (req, res) => {
  const { id } = req.params;

  // Objects first: if the row went first and the deletes failed, the bucket
  // would keep paying for files nothing references any more.
  const staged = await deletePrefix(`output/${id}/`);
  const built = await deletePrefix(`dist/${id}/`);
  const removed = await deleteDeployment(id);

  if (!removed) {
    res.status(404).json({ error: "no such deployment", objectsDeleted: staged + built });
    return;
  }

  res.json({ id, objectsDeleted: staged + built });
});

async function main() {
  await publisher.connect();
  app.listen(3000);
}

main();
