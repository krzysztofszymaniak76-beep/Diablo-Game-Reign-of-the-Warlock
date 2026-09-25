import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from "./browser-lifecycle.mjs";

const [widthText = "1536", heightText = "1024"] = process.argv.slice(2);
const width = Number(widthText);
const height = Number(heightText);
if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error("Width and height must be integers");

const output = path.resolve("work", `ui-${width}x${height}.png`);
const appUrl = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4173/";
await mkdir(path.dirname(output), { recursive: true });
installGlobalCleanupHandlers();
let browser;

try {
  browser = await launchTrackedBrowser({
    appUrl: `${appUrl}${appUrl.includes("?") ? "&" : "?"}capture=${Date.now()}`,
    windowSize: `${width},${height}`,
    waitForDevtools: false,
    stdio: "inherit",
    extraArgs: ["--disable-cache", `--screenshot=${output}`],
  });
  const child = browser.child;

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error(`Edge exited with ${exitCode}`);
  const result = await stat(output);
  console.log(`${output} ${result.size} bytes`);
} finally {
  await cleanupTrackedBrowser(browser);
}
