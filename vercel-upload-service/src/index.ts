import express from "express";
import cors from "cors";
import { generate } from "./utils";
import simpleGit from "simple-git";
import { getAllFiles } from "./file";
import path from "path";


const app = express();
app.use(cors());
app.use(express.json());


app.post("/deploy", async (req, res) => {
  const repoUrl = req.body.repoUrl;

  const id = generate();
  await simpleGit().clone(repoUrl, path.resolve(__dirname, `output/${id}`));

  const files = getAllFiles(path.resolve(__dirname, `output/${id}`));
  console.log(repoUrl);
  console.log(files);
  res.json({id: id});
})

app.listen(3000);
