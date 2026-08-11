import { S3, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

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

export async function downloadS3Folder(prefix: string) {
    const allFiles = await s3.listObjectsV2({
        Bucket: "vercel",
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
                Bucket: "vercel",
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