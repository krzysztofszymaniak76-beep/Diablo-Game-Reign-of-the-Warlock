import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
} from "./browser-lifecycle.mjs";

const [label = "after-v0.5.17", rawUrl = "http://127.0.0.1:4317/?training=1&skip-team-selection=1"] = process.argv.slice(2);
if (!/^[a-z0-9.-]+$/i.test(label)) throw new Error("Label contains unsupported characters");
const appUrl = new URL(rawUrl).href;
const viewports = Object.freeze([
  Object.freeze({ width: 1280, height: 720 }),
  Object.freeze({ width: 1536, height: 864 }),
  Object.freeze({ width: 1920, height: 1080 }),
]);
const outputDirectory = path.resolve(process.env.ROTW_HUD_EVIDENCE_DIR ?? path.join("docs", "evidence", "v0.5.17"));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", async (event) => {
      let payload = event.data;
      if (typeof payload !== "string" && typeof payload?.text === "function") payload = await payload.text();
      const message = JSON.parse(String(payload));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    this.socket?.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression).catch(() => false)) return;
    await pause(75);
  }
  throw new Error(`Timeout: ${description}`);
}

installGlobalCleanupHandlers();
await mkdir(outputDirectory, { recursive: true });
let browser;
let cdp;

try {
  browser = await launchTrackedBrowser({
    appUrl: "about:blank",
    windowSize: "1920,1080",
    stdio: ["ignore", "pipe", "pipe"],
  });
  cdp = new CdpClient(browser.target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable")]);

  for (const { width, height } of viewports) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const target = new URL(appUrl);
    target.searchParams.set("evidence", `${label}-${width}x${height}`);
    await cdp.send("Page.navigate", { url: target.href });
    await waitFor(cdp, `document.readyState === "complete" && Boolean(document.querySelector("#scene"))`, `gotowy ekran ${width}x${height}`);
    await evaluate(cdp, `(async () => {
      await document.fonts?.ready;
      const imagesReady = Promise.all([...document.images].map((image) => image.complete
        ? image.decode?.().catch(() => {})
        : new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })));
      await Promise.race([imagesReady, new Promise((resolve) => setTimeout(resolve, 8000))]);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`);
    const layout = await evaluate(cdp, `(() => ({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      canvas: (() => { const r = document.querySelector("#scene").getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom }; })(),
      hud: (() => { const r = document.querySelector(".d2r-command-hud").getBoundingClientRect(); return { top:r.top, bottom:r.bottom }; })(),
      lifeOrb: (() => { const r = document.querySelector("#life-orb").getBoundingClientRect(); return { top:r.top, bottom:r.bottom }; })(),
      manaOrb: (() => { const r = document.querySelector("#mana-orb").getBoundingClientRect(); return { top:r.top, bottom:r.bottom }; })(),
    }))()`);
    if (layout.width !== width || layout.height !== height
      || layout.scrollWidth > width + 1 || layout.scrollHeight > height + 1
      || layout.canvas.left < -1 || layout.canvas.top < -1
      || layout.canvas.right > width + 1 || layout.canvas.bottom > height + 1) {
      throw new Error(`Nieprawidłowy układ ${width}x${height}: ${JSON.stringify(layout)}`);
    }
    if (label.startsWith("after-") && (
      layout.hud.top < layout.canvas.bottom - 1
      || layout.hud.top > layout.canvas.bottom + 12
      || layout.lifeOrb.top < layout.hud.top - 1
      || layout.manaOrb.top < layout.hud.top - 1
      || layout.lifeOrb.top > layout.hud.top + 26
      || layout.manaOrb.top > layout.hud.top + 26
      || layout.lifeOrb.bottom > height + 1
      || layout.manaOrb.bottom > height + 1
    )) throw new Error(`Kule nie są bezpośrednio pod planszą ${width}x${height}: ${JSON.stringify(layout)}`);
    if (process.env.ROTW_HUD_CHECK_TORCHES === "1") {
      const flameTimes = await evaluate(cdp, `(() => [...document.querySelectorAll('.battle-torch .torch-flame')].map(element => element.getAnimations()[0]?.currentTime ?? null))()`);
      await pause(340);
      const laterTimes = await evaluate(cdp, `(() => [...document.querySelectorAll('.battle-torch .torch-flame')].map(element => element.getAnimations()[0]?.currentTime ?? null))()`);
      if (flameTimes.length !== 2 || flameTimes.some((time, index) =>
        typeof time !== 'number' || typeof laterTimes[index] !== 'number' || laterTimes[index] - time < 200)) {
        throw new Error(`Pochodnie nie animują się płynnie ${width}x${height}: ${JSON.stringify({ flameTimes, laterTimes })}`);
      }
      process.stdout.write(`TORCH_ANIMATION ${width}x${height} ${JSON.stringify({ flameTimes, laterTimes })}\n`);
    }
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    });
    const file = path.join(outputDirectory, `hud-${label}-${width}x${height}.png`);
    await writeFile(file, Buffer.from(screenshot.data, "base64"));
    process.stdout.write(`${file}\n`);
    if (process.env.ROTW_HUD_CAPTURE_CLOSEUP === "1" && width === 1920) {
      const closeup = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true,
        clip: { x: 0, y: layout.hud.top, width, height: height - layout.hud.top, scale: 2 },
      });
      const closeupFile = path.join(outputDirectory, `hud-closeup-${label}-${width}x${height}.png`);
      await writeFile(closeupFile, Buffer.from(closeup.data, "base64"));
      process.stdout.write(`${closeupFile}\n`);
    }
    if (process.env.ROTW_HUD_CAPTURE_DETAILS === "1" && width === 1920) {
      for (const [name, clip] of [
        ["party", { x: 0, y: 48, width: 185, height: 340, scale: 2 }],
        ["torch-left", { x: 150, y: 0, width: 270, height: 540, scale: 2 }],
        ["torch-right", { x: 1650, y: 0, width: 270, height: 540, scale: 2 }],
      ]) {
        const detail = await cdp.send("Page.captureScreenshot", {
          format: "png", captureBeyondViewport: false, fromSurface: true, clip,
        });
        const detailFile = path.join(outputDirectory, `${name}-${label}-${width}x${height}.png`);
        await writeFile(detailFile, Buffer.from(detail.data, "base64"));
        process.stdout.write(`${detailFile}\n`);
      }
    }
    if (process.env.ROTW_HUD_CHECK_CONTROLS === "1") {
      for (const side of ["left", "right"]) {
        const selector = `#mouse-skill-${side}`;
        const point = await evaluate(cdp, `(() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return { x, y, unobscured: document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)}) === button };
        })()`);
        if (!point.unobscured) throw new Error(`Przycisk ${selector} jest zasłonięty w ${width}x${height}`);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        const opened = await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'true' && !document.querySelector('#mouse-skill-chooser').classList.contains('hidden')`);
        if (!opened) throw new Error(`Wybór umiejętności ${selector} nie otwiera się w ${width}x${height}`);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        const closed = await evaluate(cdp, `document.querySelector('#mouse-skill-chooser').classList.contains('hidden')`);
        if (!closed) throw new Error(`Wybór umiejętności ${selector} nie zamyka się w ${width}x${height}`);
      }
      const hitAreas = await evaluate(cdp, `(() => [
        '#hud-belt-slot-1', '#hud-belt-slot-2', '#hud-belt-slot-3', '#hud-belt-slot-4',
        '#end-turn', '#save', '#load', '#pause',
        ...[...document.querySelectorAll('.mouse-hud-shortcuts button')].map((_, index) => '.mouse-hud-shortcuts button:nth-child(' + (index + 1) + ')'),
      ].map(selector => {
        const button = document.querySelector(selector);
        const rect = button?.getBoundingClientRect();
        const x = rect?.left + rect?.width / 2;
        const y = rect?.top + rect?.height / 2;
        return { selector, visible: !!rect && rect.width > 0 && rect.height > 0,
          unobscured: !!rect && document.elementFromPoint(x, y)?.closest(selector) === button };
      }))()`);
      if (hitAreas.some(area => !area.visible || !area.unobscured)) {
        throw new Error(`Zasłonięte sterowanie HUD ${width}x${height}: ${JSON.stringify(hitAreas.filter(area => !area.visible || !area.unobscured))}`);
      }
      const partyNames = await evaluate(cdp, `[...document.querySelectorAll('#party [data-character-id]')].map(button => button.dataset.characterId)`);
      if (partyNames.length >= 2) {
        const original = await evaluate(cdp, `document.querySelector('#mouse-skill-owner').textContent`);
        const point = await evaluate(cdp, `(() => { const rect = document.querySelectorAll('#party [data-character-id]')[1].getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        const changed = await evaluate(cdp, `document.querySelector('#mouse-skill-owner').textContent !== ${JSON.stringify(original)}
          && document.querySelector('#mana-orb-value').textContent.trim() !== '—'`);
        if (!changed) throw new Error(`Lista drużyny nie aktualizuje aktywnej postaci i many ${width}x${height}`);
      }
      process.stdout.write(`HUD_CONTROLS ${width}x${height} LPM/PPM, pas, skróty, system i drużyna działają/pozostają dostępne\n`);
    }
  }
} finally {
  cdp?.close();
  await cleanupTrackedBrowser(browser);
}
