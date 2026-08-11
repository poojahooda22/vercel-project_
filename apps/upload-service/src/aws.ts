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
      await s3.send(
        new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } })
      );
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
