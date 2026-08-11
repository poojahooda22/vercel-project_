import { S3, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client, s3Bucket } from "@vercel-clone/shared";

export const BUCKET = s3Bucket();

const s3 = createS3Client();

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
