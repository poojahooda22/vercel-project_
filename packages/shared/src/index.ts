// Everything here is a factory or a type — nothing runs on import. A service that
// only wants `required` does not end up constructing an S3 client, and importing
// this package never fails on an environment variable the caller does not use.
export { required } from "./env";
export { createS3Client, s3Bucket } from "./s3";
export { createRedisClient, BUILD_QUEUE, SCREENSHOT_QUEUE } from "./redis";
export type { Deployment, DeploymentState } from "./types";
