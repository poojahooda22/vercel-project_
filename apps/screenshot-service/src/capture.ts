import http from "http";
import { chromium, type Browser } from "playwright";

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const REQUEST_HANDLER_ORIGIN = optional("REQUEST_HANDLER_ORIGIN", "http://127.0.0.1:3001");
const PREVIEW_HOST = optional("PREVIEW_HOST", "localhost:3001");

/**
 * Optional Chromium resolver override, e.g. "MAP *.localhost caddy".
 *
 * Needed inside Docker. The liveness poll below talks to the request handler by
 * service name, so it works — but Chromium navigates to the real visitor URL
 * `http://{id}.<PREVIEW_HOST>/`, and inside a container `*.localhost` resolves to
 * that container's OWN loopback, where nothing listens: ERR_CONNECTION_REFUSED.
 *
 * Mapping the wildcard onto the proxy reproduces what production does with real
 * DNS, so the browser exercises the same path a visitor would rather than a
 * special-cased internal address.
 */
const HOST_RESOLVER_RULES = process.env.CHROMIUM_HOST_RESOLVER_RULES;

// Card thumbnails, not archival captures. Viewport-only also sidesteps Chromium's
// 16384px compositor texture limit entirely — a page that reports an absurd scroll
// height can never turn into an allocation big enough to take the box down.
const VIEWPORT = { width: 1280, height: 800 };

const LIVE_POLL_TIMEOUT_MS = 30_000;
const LIVE_POLL_INTERVAL_MS = 1_000;
const NAV_TIMEOUT_MS = 30_000;
const PAINT_TIMEOUT_MS = 15_000;
const SETTLE_MS = 750;

/** The URL a real visitor would open. */
export function deploymentUrl(id: string): string {
  return `http://${id}.${PREVIEW_HOST}/`;
}

/**
 * Wait until the request handler actually serves this deployment.
 *
 * Uploading the last file to R2 is not the same as the site being reachable, and
 * capturing in that gap photographs a 404. We connect to the handler by IP and set
 * Host ourselves: Node's resolver has no obligation to map *.localhost to loopback,
 * and relying on it would make liveness depend on the dev machine's DNS.
 */
function probeOnce(id: string): Promise<string> {
  const origin = new URL(REQUEST_HANDLER_ORIGIN);

  return new Promise((resolve) => {
    // node:http, NOT fetch. `Host` is a forbidden header name in the fetch spec, so
    // undici drops it silently — the request then arrives as Host: 127.0.0.1, the
    // handler reads the first label as the deployment id, and every probe 404s.
    const req = http.request(
      {
        host: origin.hostname,
        port: origin.port || 80,
        path: "/",
        method: "GET",
        headers: { Host: `${id}.${PREVIEW_HOST}`, Accept: "text/html" },
        timeout: LIVE_POLL_INTERVAL_MS * 2,
      },
      (res) => {
        res.resume(); // drain, or the socket is never released
        resolve(`HTTP ${res.statusCode}`);
      }
    );
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.on("error", (e) => resolve(e.message));
    req.end();
  });
}

async function waitUntilLive(id: string): Promise<void> {
  const deadline = Date.now() + LIVE_POLL_TIMEOUT_MS;
  let last = "no response";

  while (Date.now() < deadline) {
    last = await probeOnce(id);
    if (last === "HTTP 200") return;
    await new Promise((r) => setTimeout(r, LIVE_POLL_INTERVAL_MS));
  }

  throw new Error(`deployment never became reachable within ${LIVE_POLL_TIMEOUT_MS}ms (last: ${last})`);
}

// One browser, reused across captures — launching is the expensive step. Each
// capture still gets its own context, so cookies, storage and cache never leak
// between two tenants' sites.
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  // Deliberately NOT --no-sandbox. The serverless Chromium builds disable the
  // sandbox because Lambda is a throwaway root microVM; this worker is a
  // long-lived process sitting next to live R2 and Neon credentials, and it
  // renders arbitrary user-deployed JavaScript.
  const args = HOST_RESOLVER_RULES
    ? [`--host-resolver-rules=${HOST_RESOLVER_RULES}`]
    : [];
  browser = await chromium.launch({ headless: true, args });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => {});
  browser = null;
}

/**
 * True once the page has painted something worth photographing.
 *
 * `load` fires when the document is loaded, which for a Vite/CRA/Next SPA is an
 * empty <div id="root"> — the framework has not run yet. That single fact is what
 * turns a screenshot feature into a wall of blank white cards, so the count check
 * below deliberately rejects a lone unfilled mount node.
 */
const PAINTED = `() => {
  const body = document.body;
  if (!body) return false;
  if ((body.innerText || '').trim().length > 0) return true;
  if (document.querySelector('canvas, img, svg, video')) return true;
  return body.querySelectorAll('*').length > 10;
}`;

export interface Capture {
  image: Buffer;
  /** False when the paint probe timed out — the image may be blank. */
  painted: boolean;
}

export async function captureScreenshot(id: string): Promise<Capture> {
  await waitUntilLive(id);

  const context = await (await getBrowser()).newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    // A capture must never write to disk, and a site that opens a dialog on load
    // would otherwise block navigation until the timeout.
    acceptDownloads: false,
    reducedMotion: "reduce",
  });

  try {
    const page = await context.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));

    await page.goto(deploymentUrl(id), { waitUntil: "load", timeout: NAV_TIMEOUT_MS });

    // Fallback glyphs reflow the moment the real font arrives, so a capture taken
    // before this resolves can disagree with what any visitor sees.
    await page.evaluate(() => document.fonts.ready).catch(() => {});

    let painted = true;
    try {
      await page.waitForFunction(PAINTED, undefined, { timeout: PAINT_TIMEOUT_MS });
    } catch {
      // Capture anyway: a blank thumbnail is visible evidence that this site never
      // painted, which is more useful than silently having no image at all.
      painted = false;
    }

    await page.waitForTimeout(SETTLE_MS);

    const image = await page.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage: false,
      animations: "disabled",
    });

    return { image, painted };
  } finally {
    await context.close().catch(() => {});
  }
}
