import path from "path";
import { createClient } from "redis";
import { copyFinalDist, downloadS3Folder } from "./aws";
import { buildProject } from "./utils";
import { claimDeployment, markDeployed, markFailed } from "./db";
import { planBuild, resolvePublishDir } from "./publish-dir";


const subscriber = createClient();
subscriber.on("error", (err) => console.error("Redis client error", err));

async function main() {
    await subscriber.connect();
    console.log("worker waiting on build-queue");

    while (1) {
        const res = await subscriber.brPop("build-queue", 0);
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
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await markFailed(id, message);
            console.log(`  ${id} FAILED: ${message}`);
        }
    }
}
main();