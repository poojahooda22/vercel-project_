import fs from "fs";
import path from "path";

export function getAllFiles(dirPath: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    // Git history is not part of the site: 34% of the clone's bytes, and it would
    // expose every commit of a private repo through the public request handler.
    if (entry.name === ".git") continue;

    const fullPath = path.join(dirPath, entry.name);

    // A symlink in a cloned repo can point anywhere on the host, so following one
    // would stage files from outside the clone into the bucket.
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}
