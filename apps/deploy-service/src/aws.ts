import { PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { createS3Client, s3Bucket } from "@vercel-clone/shared";

export const BUCKET = s3Bucket();
const s3 = createS3Client();

export async function downloadS3Folder(prefix: string) {
    // BUCKET, not a hardcoded "vercel": downloads used the literal while uploads
    // used $S3_BUCKET, so renaming the bucket would break reads and silently send
    // writes somewhere else. They agreed only because the env held the same string.
    const allFiles = await s3.listObjectsV2({
        Bucket: BUCKET,
        Prefix: prefix
    });
    
    // get all files as array of strings [output/asdas/index.html, output/asdas/index.css]
    const allPromises = allFiles.Contents?.map(async ({Key}) => {           
        return new Promise (async (resolve) => {
            const finalOutputPath = path.join(__dirname, Key || ""); // dist/output/asdas/src
            //below code is a way to copy all files from S3
            const outputFile = fs.createWriteStream(finalOutputPath);
            const dirName = path.dirname(finalOutputPath);
            if (!fs.existsSync(dirName)){
                fs.mkdirSync(dirName, { recursive: true });
            }
            const { Body } = await s3.getObject({
                Bucket: BUCKET,
                Key: Key || ""
            });
            (Body as Readable).pipe(outputFile).on("finish", () => {
                resolve("");
            });
        })       
    }) || []
    console.log('waiting');
    await Promise.all(allPromises?.filter(x => x !== undefined));
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