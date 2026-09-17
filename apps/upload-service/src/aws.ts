import fs from "fs";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3,
} from "@aws-sdk/client-s3";
import { createS3Client, s3Bucket } from "@vercel-clone/shared";

export const BUCKET = s3Bucket();

const s3 = createS3Client();

/**
 * Removes every object under a prefix. Paginated because listObjectsV2 returns at
 * most 1000 keys per call — without the token loop a large deployment would leave
 * orphaned objects behind, silently billed forever.
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
      // Quiet mode lists exactly the keys that were NOT deleted: a partial batch
      // is an error to the caller, not a count that claims a clean sweep.
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

/**
 * Reads one object, or null when it does not exist.
 *
 * Screenshots are served through this service rather than from a public bucket
 * URL: deployment ids are short, so a guessable public key namespace would let
 * anyone enumerate every project's preview image.
 */
export async function getObjectBytes(key: string): Promise<Buffer | null> {
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: key });
    if (!obj.Body) return null;
    return Buffer.from(await obj.Body.transformToByteArray());
  } catch (e) {
    const name = (e as { name?: string }).name;
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === "NoSuchKey" || name === "NotFound" || status === 404) return null;
    throw e;
  }
}

// fileName is the destination object name, e.g. "output/a1b2c/src/App.jsx".
// localFilePath is where the file lives on this machine.
//
// Streamed, with the length declared up front (R2 needs it), so a deploy's memory
// is a few chunks per in-flight upload rather than the whole tree: the previous
// readFileSync read every file of the repository into Buffers before the first
// PUT finished.
export async function uploadFile(
  fileName: string,
  localFilePath: string,
  signal?: AbortSignal
): Promise<void> {
  const { size } = await fs.promises.stat(localFilePath);
  // The handler pipes the stream into the request and, on abort or error, destroys
  // only the request: the stream would stay open with its descriptor, and on Linux
  // an unlinked-but-open file keeps its blocks. destroy() is idempotent after a
  // normal end.
  const body = fs.createReadStream(localFilePath);
  try {
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: fileName, Body: body, ContentLength: size }),
      { abortSignal: signal }
    );
  } finally {
    body.destroy();
  }
}
