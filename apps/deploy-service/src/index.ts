import fs from "fs";
import path from "path";
import { copyFinalDist, deletePrefix, downloadS3Folder, localDir } from "./aws";
import { buildProject } from "./utils";
import { claimDeployment, markDeployed, markFailed, promoteIfNewer } from "./db";
import { planBuild, resolvePublishDir } from "./publish-dir";
import { createRedisClient, BUILD_QUEUE, SCREENSHOT_QUEUE } from "@vercel-clone/shared";


const subscriber = createRedisClient("deploy/subscriber");

// A second connection for publishing: brPop blocks the one it runs on, and node-redis
// wants a dedicated client for blocking commands rather than sharing one.
const publisher = createRedisClient("deploy/publisher");

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Removes a build's local tree — source, node_modules, output. Runs after every
 * build whatever its outcome, so local scratch is bounded by the builds in
 * flight, not by how many were ever run, and a deleted deployment's source does
 * not stay readable on the box. Best effort: a directory that will not go is
 * logged, and the boot sweep reclaims it next time.
 */
async function removeLocal(id: string): Promise<void> {
    try {
        await fs.promises.rm(localDir(id), { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
        console.error(`  ${id}: local build directory not removed:`, message(e));
    }
}

/** At boot nothing under output/ belongs to a running build; it was left by a killed process. */
async function sweepLocal(): Promise<void> {
    let names: string[];
    try {
        names = await fs.promises.readdir(path.dirname(localDir("x")));
    } catch {
        return;
    }
    for (const name of names) await removeLocal(name);
    if (names.length > 0) console.log(`swept ${names.length} leftover build director${names.length === 1 ? "y" : "ies"}`);
}

async function main() {
    await sweepLocal();
    await subscriber.connect();
    await publisher.connect();
    console.log("worker waiting on build-queue");

    while (1) {
        const res = await subscriber.brPop(BUILD_QUEUE, 0);
        const id = res?.element;
        if (!id) continue;
        console.log("popped id:", id);

        // queued -> building. Losing the claim means another worker owns it.
        const claim = await claimDeployment(id);
        if (!claim.claimed) {
            console.log(`  skipped ${id}: not in 'queued' state`);
            continue;
        }

        // One bad deployment must not kill the worker for every other tenant.
        try {
            let downloaded: number;
            try {
                downloaded = await downloadS3Folder(`output/${id}`);
            } catch (e) {
                // A fixed sentence on the row; the cause (which names buckets and
                // hosts) goes to the log only.
                console.error(`  ${id}: download failed:`, message(e));
                throw new Error("The staged files could not be read from storage; deploy again.");
            }
            console.log(`  downloaded ${downloaded} file(s)`);

            const repoDir = localDir(id);

            // Decide BEFORE touching npm. A repo with no package.json must never
            // reach npm at all, or npm walks up and builds this service instead.
            const plan = planBuild(repoDir);
            console.log(`  ${plan.reason}`);

            let publishDir = plan.publishDir;

            if (plan.needsBuild) {
                const exitCode = await buildProject(id, claim.buildEnv);
                if (exitCode !== 0) {
                    await markFailed(id, `build exited with code ${exitCode}`);
                    console.log(`  ${id} FAILED: exit code ${exitCode}`);
                    continue;
                }
                publishDir = resolvePublishDir(repoDir);
                console.log(`  publishing ${path.basename(publishDir)}/`);
            }

            await copyFinalDist(id, publishDir);
            // The guarded transition is also the check that the row still exists: a
            // deployment (or its whole project) deleted while this build ran has had
            // its objects swept already, and what was just uploaded must not outlive
            // the row — a site nobody can see in a dashboard, served forever.
            if (!(await markDeployed(id))) {
                try {
                    const swept = (await deletePrefix(`dist/${id}/`)) + (await deletePrefix(`output/${id}/`));
                    console.log(`  ${id} finished but its row is gone; swept ${swept} object(s)`);
                } catch (e) {
                    console.error(`  ${id} finished but its row is gone, and the sweep failed:`, message(e));
                }
                continue;
            }
        } catch (e) {
            // What the build threw is what the row says (the publish-dir checks throw
            // the sentences the dashboard shows); recording it must not itself be
            // able to kill the worker.
            await markFailed(id, message(e)).catch((inner) =>
                console.error(`  ${id}: could not record the failure:`, message(inner))
            );
            console.log(`  ${id} FAILED: ${message(e)}`);
            continue;
        } finally {
            await removeLocal(id);
        }

        // Past the commit: the row says deployed. Promotion and the screenshot are
        // follow-ups. A failure here is not a failed build (and markFailed would
        // not touch a deployed row anyway): it is logged with the id, production
        // stays where it was until the next build or a manual promote, and the
        // screenshot is simply missing.
        try {
            const promoted = await promoteIfNewer(id);
            console.log(`  ${id} deployed${promoted ? " and promoted to production" : ""}`);
        } catch (e) {
            console.error(`  ${id} deployed, but promotion failed (production unchanged):`, message(e));
        }
        // Hand the screenshot off only once the deployment is live and recorded.
        // Capturing here in-process would photograph the site before the request
        // handler can serve it.
        try {
            await publisher.lPush(SCREENSHOT_QUEUE, id);
        } catch (e) {
            console.error(`  ${id}: screenshot not queued:`, message(e));
        }
    }
}
main();
