import { S3 } from "@aws-sdk/client-s3";
import { required } from "./env";

/**
 * Builds the R2 client. All four services constructed this identically — verified
 * byte-for-byte before extracting — so there was no per-service variation to lose.
 *
 * A FACTORY rather than a shared instance: a module-scope `new S3(...)` would run
 * `required()` the moment anything imported this package, so a service that only
 * wanted `required` or a type would crash on missing S3 credentials it never uses.
 *
 * region "auto" is R2's convention: it is a single global namespace with no regions,
 * but the S3 protocol requires the field, so any non-empty value would do.
 */
export function createS3Client(): S3 {
  const accountId = required("ACCOUNT_ID");
  return new S3({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    },
  });
}

/**
 * The one place the bucket name comes from.
 *
 * The deploy worker used to hardcode "vercel" for downloads while uploading to
 * $S3_BUCKET. Those agreed only because the env happened to hold the same string;
 * renaming the bucket would have broken reads while writes silently went elsewhere.
 */
export function s3Bucket(): string {
  return required("S3_BUCKET");
}
