import { captureScreenshot, closeBrowser, deploymentUrl } from "./capture";
import { uploadScreenshot } from "./aws";
import { markScreenshot } from "./db";
import { createRedisClient, SCREENSHOT_QUEUE } from "@vercel-clone/shared";

const QUEUE = SCREENSHOT_QUEUE;

const subscriber = createRedisClient("screenshot/subscriber");

async function main() {
  await subscriber.connect();
  console.log(`screenshot worker waiting on ${QUEUE}`);

  while (1) {
    const res = await subscriber.brPop(QUEUE, 0);
    const id = res?.element;
    if (!id) continue;
    console.log(`popped id: ${id} -> ${deploymentUrl(id)}`);

    // A screenshot is decoration. Nothing in here may change deployment state, and
    // one site that hangs or crashes Chromium must not stop the worker serving the
    // next tenant — so every failure is caught, logged, and dropped.
    try {
      const started = Date.now();
      const { image, painted } = await captureScreenshot(id);
      await uploadScreenshot(id, image);

      const recorded = await markScreenshot(id);
      const size = (image.length / 1024).toFixed(0);
      const took = ((Date.now() - started) / 1000).toFixed(1);

      if (!recorded) {
        console.log(`  ${id}: captured but row not updated (deleted, or no longer 'deployed')`);
      } else if (!painted) {
        console.log(`  ${id}: captured in ${took}s (${size} KB) — WARNING: page never painted, image may be blank`);
      } else {
        console.log(`  ${id}: captured in ${took}s (${size} KB)`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`  ${id}: screenshot failed — ${message}`);
      // A crashed or wedged browser poisons every later capture, so drop it and
      // let the next job launch a clean one.
      await closeBrowser();
    }
  }
}

// Chromium is a child process; without this a Ctrl-C leaves it running.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\n${signal} — shutting down`);
    await closeBrowser();
    await subscriber.quit().catch(() => {});
    process.exit(0);
  });
}

main();
