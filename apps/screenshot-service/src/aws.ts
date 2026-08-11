import { S3, PutObjectCommand } from "@aws-sdk/client-s3";

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

/** One key per deployment id — the same shape the delete path prefix-sweeps. */
export function screenshotKey(id: string): string {
  return `screenshots/${id}.jpg`;
}

export async function uploadScreenshot(id: string, image: Buffer): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: screenshotKey(id),
      Body: image,
      ContentLength: image.length,
      ContentType: "image/jpeg",
    })
  );
}
