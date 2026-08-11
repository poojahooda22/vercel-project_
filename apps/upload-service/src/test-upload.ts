import fs from "fs";
import path from "path";
import { HeadObjectCommand, S3 } from "@aws-sdk/client-s3";
import { uploadFile, BUCKET } from "./aws";

// Standalone check that uploadFile works. Run it with:
//   npm run build && node --env-file=.env dist/test-upload.js
async function main() {
  // Forward slashes, or "\d" / "\r" / "\v" get read as escape characters.
  const localFilePath = path.resolve(__dirname, "output/rhsac/README.md");
  const key = "pooja/README.md";

  console.log("local file :", localFilePath);
  console.log("target key :", key);

  await uploadFile(key, localFilePath);

  // Returning without throwing is not proof: ask R2 whether the object is there,
  // and whether its size matches the file we sent.
  const s3 = new S3({
    region: "auto",
    endpoint: `https://${process.env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });

  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const localSize = fs.statSync(localFilePath).size;

  console.log(`\nfound in bucket "${BUCKET}"`);
  console.log("  remote size:", head.ContentLength, "bytes");
  console.log("  local size :", localSize, "bytes");
  console.log(head.ContentLength === localSize ? "\nPASS: uploadFile works." : "\nFAIL: size mismatch.");
}

main().catch((e) => {
  console.error("\nuploadFile FAILED:", e.name, "-", e.message);
  process.exit(1);
});
