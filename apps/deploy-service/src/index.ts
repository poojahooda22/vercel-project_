import path from "path";
import { copyFinalDist, downloadS3Folder } from "./aws";
import { buildProject } from "./utils";
import { claimDeployment, markDeployed, markFailed } from "./db";
import { planBuild, resolvePublishDir } from "./publish-dir";
import { createRedisClient, BUILD_QUEUE, SCREENSHOT_QUEUE } from "@vercel-clone/shared";


const subscriber = createRedisClient("deploy/subscriber");

// A second connection for publishing: brPop blocks the one it runs on, and node-redis
// wants a dedicated client for blocking commands rather than sharing one.
const publisher = createRedisClient("deploy/publisher");

async function main() {
    await subscriber.connect();
    await publisher.connect();
    console.log("worker waiting on build-queue");

    while (1) {
        const res = await subscriber.brPop(BUILD_QUEUE, 0);
        const id = res?.element;
        if (!id) continue;
        console.log("popped id:", id);

        // queued -> building. Losing the claim means another worker owns it.
        if (!(await claimDeployment(id))) {
            console.log(`  skipped ${id}: not in 'queued' state`);
            continue;
        }

        // One bad deployment must not kill the worker for every other tenant.
        try {
            await downloadS3Folder(`output/${id}`);
            console.log('downloaded');

            const repoDir = path.join(__dirname, `output/${id}`);

            // Decide BEFORE touching npm. A repo with no package.json must never
            // reach npm at all, or npm walks up and builds this service instead.
            const plan = planBuild(repoDir);
            console.log(`  ${plan.reason}`);

            let publishDir = plan.publishDir;

            if (plan.needsBuild) {
                const exitCode = await buildProject(id);
                if (exitCode !== 0) {
                    await markFailed(id, `build exited with code ${exitCode}`);
                    console.log(`  ${id} FAILED: exit code ${exitCode}`);
                    continue;
                }
                publishDir = resolvePublishDir(repoDir);
                console.log(`  publishing ${path.basename(publishDir)}/`);
            }

            await copyFinalDist(id, publishDir);
            await markDeployed(id);
            console.log(`  ${id} deployed`);

            // Hand the screenshot off only once the deployment is live and recorded.
            // Capturing here in-process would photograph the site before the request
            // handler can serve it, and a Chromium failure would land inside this
            // try/catch and mark a perfectly good build as failed.
            await publisher.lPush(SCREENSHOT_QUEUE, id);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await markFailed(id, message);
            console.log(`  ${id} FAILED: ${message}`);
        }
    }
}
main();