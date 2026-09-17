import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createS3Client, s3Bucket } from "@vercel-clone/shared";

export const BUCKET = s3Bucket();
const s3 = createS3Client();

const OUTPUT_ROOT = path.join(__dirname, "output");

/** Where a deployment's staged tree is downloaded to: output/{id} beside this file. */
export function localDir(id: string): string {
    return path.join(OUTPUT_ROOT, id);
}

// How many objects are fetched at once. Bounded so a large tree does not open a
// thousand sockets and file descriptors in one go.
const DOWNLOAD_POOL = 16;

/**
 * Downloads every object under a prefix into this process's output directory
 * and returns how many. Every step is awaited, so a missing or unreadable
 * object — a deployment deleted while its build was starting, a transient
 * storage error — rejects this promise and lands in the caller's catch, never
 * in a discarded promise that would take the whole worker down as an
 * unhandled rejection.
 */
export async function downloadS3Folder(prefix: string): Promise<number> {
    // BUCKET, not a hardcoded "vercel": downloads used the literal while uploads
    // used $S3_BUCKET, so renaming the bucket would break reads and silently send
    // writes somewhere else. They agreed only because the env held the same string.
    let token: string | undefined;
    let count = 0;
    do {
        const page = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token });
        const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
        for (let i = 0; i < keys.length; i += DOWNLOAD_POOL) {
            await Promise.all(keys.slice(i, i + DOWNLOAD_POOL).map((key) => downloadObject(key)));
        }
        count += keys.length;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return count;
}

async function downloadObject(key: string): Promise<void> {
    const target = path.join(__dirname, key);
    // Keys are this platform's own uploads, but a key that would resolve outside
    // the output directory is refused rather than written.
    if (!target.startsWith(OUTPUT_ROOT + path.sep)) throw new Error(`refusing to write outside output/: ${key}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const { Body } = await s3.getObject({ Bucket: BUCKET, Key: key });
    if (!Body) throw new Error(`empty body for ${key}`);
    await pipeline(Body as Readable, fs.createWriteStream(target));
}

/**
 * Removes every object under a prefix, paginated (listObjectsV2 returns at most
 * 1000 keys per call). The worker needs this for one case: a deployment deleted
 * while its build was running, whose output must not outlive its row. A batch
 * that only partly succeeded is an error, not a count: in quiet mode the
 * response lists exactly the keys that were NOT deleted.
 */
export async function deletePrefix(prefix: string): Promise<number> {
    let token: string | undefined;
    let deleted = 0;
    do {
        const page = await s3.send(
            new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
        );
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
        if (keys.length > 0) {
            const out = await s3.send(
                new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } })
            );
            const errors = out.Errors ?? [];
            if (errors.length > 0) {
                throw new Error(
                    `${errors.length} of ${keys.length} object(s) under ${prefix} were not deleted: ${errors[0].Code ?? ""} ${errors[0].Message ?? ""}`
                );
            }
            deleted += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
}

export async function uploadFile(fileName: string, localFilePath: string): Promise<void> {
    const { size } = fs.statSync(localFilePath);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: fileName,
        Body: fs.readFileSync(localFilePath),
        ContentLength: size,
      })
    );
}


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

export async function copyFinalDist(id: string, publishDir: string) {
    const folderPath = publishDir;
    const allFiles = getAllFiles(folderPath);
    // Keys need the "/" after the id, and forward slashes for nested paths —
    // slicing a Windows path leaves "\" which the request handler can never match.
    await Promise.all(
        allFiles.map(file =>
            uploadFile(
                `dist/${id}/` + file.slice(folderPath.length + 1).split(path.sep).join("/"),
                file
            )
        )
    );
}
