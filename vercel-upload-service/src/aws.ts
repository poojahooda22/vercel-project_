import fs from "fs";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3,
} from "@aws-sdk/client-s3";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Set it in .env, then start with "npm run dev". ` +
        `A bare "node dist/index.js" does NOT read .env — it needs --env-file=.env.`
    );
  }
  return value;
}

const ACCOUNT_ID = required("ACCOUNT_ID");
export const BUCKET = required("S3_BUCKET");

const s3 = new S3({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  },
});

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
