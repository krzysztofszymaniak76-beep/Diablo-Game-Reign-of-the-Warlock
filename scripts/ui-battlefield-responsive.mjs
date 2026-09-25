import { readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import path from "node:path";
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from "./browser-lifecycle.mjs";

const APP_URL = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4173/";
const EDGE_PATH = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const VIEWPORTS = Object.freeze([
  Object.freeze({ width: 2560, height: 1440 }),
  Object.freeze({ width: 1920, height: 1080 }),
  Object.freeze({ width: 1536, height: 864 }),
  Object.freeze({ width: 1280, height: 720 }),
]);
const STEP_TIMEOUT_MS = 15_000;
const EDGE_STARTUP_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 120_000;
const PIXEL_EPSILON = 1.5;
const SHARED_VERTEX_EPSILON = 1.25;

let emergencyBrowser = null;
let emergencyCdp = null;
installGlobalCleanupHandlers();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message, detail) {
  const suffix = detail === undefined
    ? ""
    : `\n  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  throw new Error(`${message}${suffix}`);
}

async function waitFor(predicate, description, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  fail(`Timeout: ${description}`, lastError?.message);
}

async function requestText(url, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
        else resolve(body);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`HTTP timeout ${timeoutMs} ms`)));
    request.once("error", reject);
  });
}

async function requireServer() {
  try {
    await requestText(APP_URL, 3_000);
  } catch (error) {
    fail(`Aplikacja nie odpowiada pod ${APP_URL}. Uruchom serwer przed testem.`, error.message);
  }
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout podczas łączenia z CDP")), STEP_TIMEOUT_MS);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Nie udało się połączyć z CDP"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      this.#onMessage(event.data).catch((error) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        this.pending.clear();
      });
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Połączenie CDP zostało zamknięte"));
      }
      this.pending.clear();
    });
  }

  async #onMessage(raw) {
    let payload = raw;
    if (typeof payload !== "string" && typeof payload?.text === "function") payload = await payload.text();
    else if (payload instanceof ArrayBuffer) payload = Buffer.from(payload).toString("utf8");
    else if (ArrayBuffer.isView(payload)) payload = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
    const message = JSON.parse(String(payload));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout CDP: ${method}`));
      }, STEP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    this.socket?.close();
  }
}

async function launchHeadlessEdge(profileDirectory) {
  return launchTrackedBrowser({ edgePath: EDGE_PATH, windowSize: "1920,1080", appUrl: "about:blank", startupTimeoutMs: EDGE_STARTUP_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
}

function isFinitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

function isFiniteBounds(bounds) {
  return ["left", "top", "right", "bottom", "width", "height"].every((key) => Number.isFinite(bounds?.[key]));
}

function sharedVertexCount(left, right) {
  return left.vertices.filter((leftVertex) => right.vertices.some((rightVertex) => (
    Math.hypot(leftVertex.x - rightVertex.x, leftVertex.y - rightVertex.y) <= SHARED_VERTEX_EPSILON
  ))).length;
}

async function run() {
  await requireServer();
  const assertions = [];
  const failures = [];
  const runtimeErrors = [];
  const httpErrors = [];
  let edge;
  let cdp;

  const check = (condition, message, detail) => {
    if (condition) {
      assertions.push(message);
      process.stdout.write(`  ✓ ${message}\n`);
    } else {
      failures.push({ message, detail });
      process.stdout.write(`  ✗ ${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
    }
  };

  try {
    process.stdout.write(`Responsywny audyt pola walki: ${APP_URL}\n`);
    edge = await launchHeadlessEdge();
    emergencyBrowser = edge;
    cdp = new CdpClient(edge.target.webSocketDebuggerUrl);
    emergencyCdp = cdp;
    await cdp.connect();

    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      runtimeErrors.push(exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? "nieznany wyjątek");
    });
    cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
      if (type === "error" || type === "assert") {
        runtimeErrors.push(`console.${type}: ${args.map((item) => item.value ?? item.description ?? "").join(" ")}`);
      }
    });
    cdp.on("Log.entryAdded", ({ entry }) => {
      if (entry?.level === "error" && entry.source === "javascript") runtimeErrors.push(`log: ${entry.text}`);
    });
    cdp.on("Network.responseReceived", ({ response }) => {
      if (response?.status >= 400) httpErrors.push(`${response.status} ${response.url}`);
    });
    await Promise.all([
      cdp.send("Runtime.enable"),
      cdp.send("Page.enable"),
      cdp.send("Log.enable"),
      cdp.send("Network.enable"),
    ]);

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) fail("Runtime.evaluate zgłosił wyjątek", result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    };

    for (const requested of VIEWPORTS) {
      process.stdout.write(`\n[${requested.width} × ${requested.height}]\n`);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: requested.width,
        height: requested.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const battleUrl = new URL(APP_URL);
      battleUrl.searchParams.set("training", "1");
      battleUrl.searchParams.set("responsive", `${requested.width}x${requested.height}`);
      await cdp.send("Page.navigate", { url: battleUrl.href });
      await waitFor(async () => evaluate(`(() => (
        document.readyState === "complete"
        && typeof window.__rotwDebug?.battlefieldGeometry === "function"
        && typeof window.__rotwDebug?.projectHex === "function"
        && typeof window.__rotwDebug?.hitTestHex === "function"
        && typeof window.__rotwDebug?.hitTestClient === "function"
        && window.__rotwDebug.battlefieldGeometry()?.tiles?.length === 213
      ))()`), `gotowa geometria ${requested.width} × ${requested.height}`);
      await evaluate(`(async () => {
        await document.fonts?.ready;
        await Promise.race([
          Promise.all([...document.querySelectorAll(".battlefield-shell img")]
            .map((image) => image.decode?.().catch(() => {}))),
          new Promise((resolve) => setTimeout(resolve, 6000)),
        ]);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })()`);

      const snapshot = await evaluate(`(() => {
        const canvas = document.querySelector("#scene");
        const canvasRect = canvas?.getBoundingClientRect();
        const geometry = window.__rotwDebug.battlefieldGeometry();
        const sampleTiles = [
          geometry.tiles[0],
          geometry.tiles.at(-1),
          geometry.tiles.find(({ column, row }) => column === 2 && row === 5),
          geometry.tiles.find(({ column, row }) => column === 8 && row === 5),
          geometry.tiles.find(({ column, row }) => column === 16 && row === 5),
        ].filter(Boolean);
        const samples = sampleTiles.map(({ q, r, column }) => {
          const projected = window.__rotwDebug.projectHex(q, r);
          return { q, r, column, projected, hit: projected ? window.__rotwDebug.hitTestHex(projected.x, projected.y) : null };
        });
        const centerRoundTripFailures = [];
        const interiorRoundTripFailures = [];
        const clientRoundTripFailures = [];
        const occupiedAnchorFailures = window.__rotwDebug.snapshot().hexUnits.flatMap(({ id, position }) => {
          const tile = geometry.tiles.find(({ q, r }) => q === position.q && r === position.r);
          const projected = window.__rotwDebug.projectHex(position.q, position.r);
          return tile && projected && Math.hypot(tile.center.x - projected.x, tile.center.y - projected.y) < 0.001
            ? [] : [{ id, position, projected, tileCenter: tile?.center ?? null }];
        });
        const clientPoint = ({ x, y }) => ({
          x: canvasRect.left + x * canvasRect.width / geometry.viewport.width,
          y: canvasRect.top + y * canvasRect.height / geometry.viewport.height,
        });
        for (const tile of geometry.tiles) {
          const centerHit = window.__rotwDebug.hitTestHex(tile.center.x, tile.center.y);
          if (centerHit?.q !== tile.q || centerHit?.r !== tile.r) {
            centerRoundTripFailures.push({ tile: [tile.q, tile.r], hit: centerHit });
          }
          const points = [tile.center, ...tile.vertices.map((vertex) => ({
            x: tile.center.x + (vertex.x - tile.center.x) * 0.7,
            y: tile.center.y + (vertex.y - tile.center.y) * 0.7,
          }))];
          for (const point of points) {
            const client = clientPoint(point);
            const clientHit = window.__rotwDebug.hitTestClient(client.x, client.y);
            if (clientHit?.q !== tile.q || clientHit?.r !== tile.r) {
              clientRoundTripFailures.push({ tile: [tile.q, tile.r], point: client, hit: clientHit });
            }
          }
          for (const point of points.slice(1)) {
            const hit = window.__rotwDebug.hitTestHex(point.x, point.y);
            if (hit?.q !== tile.q || hit?.r !== tile.r) {
              interiorRoundTripFailures.push({ tile: [tile.q, tile.r], point, hit });
            }
          }
        }
        const hudHitboxes = [...document.querySelectorAll(
          '.mouse-hud-shortcuts button, .mouse-skill-slot, .d2-belt-slot, #end-turn',
        )].map((button) => {
          const rect = button.getBoundingClientRect();
          const samples = [[.5, .5], [.16, .16], [.84, .16], [.16, .84], [.84, .84]];
          const misses = samples.filter(([x, y]) => {
            const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
            return hit !== button && !button.contains(hit);
          });
          return { id: button.id || button.title, misses: misses.length, width: rect.width, height: rect.height };
        });
        const emptyBeltSlots = [...document.querySelectorAll('.d2-belt-slot')]
          .filter((button) => button.dataset.filled === 'false' && !button.querySelector('.d2-belt-item-art')).length;
        return {
          geometry,
          samples,
          centerRoundTripFailures,
          interiorRoundTripFailures,
          clientRoundTripFailures,
          occupiedAnchorFailures,
          hudHitboxes,
          emptyBeltSlots,
          layout: {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            canvas: canvasRect ? {
              left: canvasRect.left,
              top: canvasRect.top,
              right: canvasRect.right,
              bottom: canvasRect.bottom,
              width: canvasRect.width,
              height: canvasRect.height,
            } : null,
            battlefieldRight: document.querySelector(".battlefield-shell")?.getBoundingClientRect().right ?? null,
            rightPanelHidden: getComputedStyle(document.querySelector(".intel-panel")).display === "none",
            headerVisibleBlocks: [...document.querySelector(".top-frame").children]
              .filter((element) => getComputedStyle(element).display !== "none")
              .map((element) => element.className),
            locationLabel: document.querySelector(".location-block > strong")?.textContent?.trim() ?? "",
          },
        };
      })()`);

      const { geometry, samples, centerRoundTripFailures, interiorRoundTripFailures, clientRoundTripFailures,
        occupiedAnchorFailures, hudHitboxes, emptyBeltSlots, layout } = snapshot;
      const label = `${requested.width}×${requested.height}`;
      check(layout.innerWidth === requested.width && layout.innerHeight === requested.height,
        `${label}: faktyczny viewport ma żądany rozmiar`, layout);
      check(layout.scrollWidth <= layout.innerWidth + 1 && layout.scrollHeight <= layout.innerHeight + 1,
        `${label}: dokument nie ma przewijania poza viewport`, layout);
      check(isFiniteBounds(layout.canvas)
        && layout.canvas.left >= -PIXEL_EPSILON
        && layout.canvas.top >= -PIXEL_EPSILON
        && layout.canvas.right <= layout.innerWidth + PIXEL_EPSILON
        && layout.canvas.bottom <= layout.innerHeight + PIXEL_EPSILON,
      `${label}: canvas mieści się w viewport`, layout.canvas);
      check(Math.abs(geometry.viewport.width - layout.canvas.width) <= 1
        && Math.abs(geometry.viewport.height - layout.canvas.height) <= 1,
      `${label}: geometria używa rzeczywistego rozmiaru CSS canvas`, { viewport: geometry.viewport, canvas: layout.canvas });
      check(layout.rightPanelHidden && layout.battlefieldRight >= layout.innerWidth - PIXEL_EPSILON,
        `${label}: prawy panel jest ukryty, a pole walki przejmuje jego szerokość`, layout);
      check(layout.headerVisibleBlocks.length === 1
        && layout.headerVisibleBlocks[0].includes("location-block")
        && layout.locationLabel === "LOKACJA WALKI",
      `${label}: u góry pozostaje tylko mała neutralna etykieta miejsca walki`, layout);
      check(hudHitboxes.length === 14 && hudHitboxes.every(({ misses, width, height }) =>
        misses === 0 && width > 0 && height > 0),
      `${label}: 7 dolnych kafelków, LPM/PPM, koniec tury i 4 pola pasa mają trafne hitboxy`, hudHitboxes);
      check(emptyBeltSlots === 4,
        `${label}: wszystkie pola pasa startują puste, bez fantomowych ikon`, emptyBeltSlots);

      check(geometry?.reference?.mode === "approved-v3" && geometry?.tiles?.length === 213,
        `${label}: renderer publikuje 213 heksów z zatwierdzonego układu`, geometry?.reference);
      const keys = new Set((geometry?.tiles ?? []).map(({ q, r }) => `${q},${r}`));
      check(keys.size === 213, `${label}: wszystkie współrzędne heksów są unikalne`, keys.size);
      const columnCounts = Array.from(
        { length: geometry.reference.columns },
        (_, column) => geometry.tiles.filter((tile) => tile.column === column).length,
      );
      check(geometry.reference.columns === 25
        && columnCounts.length === 25
        && columnCounts.reduce((sum, count) => sum + count, 0) === 213
        && columnCounts.every((count, column) => count === (column % 2 ? 8 : 9)),
      `${label}: plansza zachowuje 25 kolumn po 9/8 pełnych pól`, columnCounts);
      const deploymentTiles = (geometry?.tiles ?? []).filter(({ deployment }) => deployment);
      check(deploymentTiles.length === 26 && deploymentTiles.every(({ column }) => column >= 0 && column < 3),
        `${label}: strefa rozstawienia ma 26 pełnych pól w pierwszych 3 kolumnach`, deploymentTiles.map(({ column, row }) => `${column},${row}`));

      const invalidTiles = (geometry?.tiles ?? []).filter((tile) => (
        !isFinitePoint(tile.center)
        || tile.vertices?.length !== 6
        || tile.vertices.some((vertex) => !isFinitePoint(vertex))
      ));
      check(invalidTiles.length === 0, `${label}: każde pole ma środek i 6 poprawnych wierzchołków`, invalidTiles.slice(0, 3));
      const outlyingVertices = (geometry?.tiles ?? []).flatMap((tile) => (tile.vertices ?? [])
        .filter(({ x, y }) => x < -PIXEL_EPSILON || y < -PIXEL_EPSILON
          || x > geometry.viewport.width + PIXEL_EPSILON || y > geometry.viewport.height + PIXEL_EPSILON)
        .map((vertex) => ({ q: tile.q, r: tile.r, ...vertex })));
      check(isFiniteBounds(geometry?.bounds)
        && geometry.bounds.left >= -PIXEL_EPSILON
        && geometry.bounds.top >= -PIXEL_EPSILON
        && geometry.bounds.right <= geometry.viewport.width + PIXEL_EPSILON
        && geometry.bounds.bottom <= geometry.viewport.height + PIXEL_EPSILON
        && outlyingVertices.length === 0,
      `${label}: pełne kontury wszystkich heksów mieszczą się w canvas`, { bounds: geometry?.bounds, outlyingVertices: outlyingVertices.slice(0, 3) });

      const widthRatio = geometry.bounds.width / geometry.viewport.width;
      const heightRatio = geometry.bounds.height / geometry.viewport.height;
      process.stdout.write(`  · zajęcie canvas: szerokość ${(widthRatio * 100).toFixed(2)}%, wysokość ${(heightRatio * 100).toFixed(2)}%\n`);
      check(widthRatio >= 0.70 && widthRatio <= 1.001,
        `${label}: szeroka plansza wykorzystuje dostępne pole canvas`, widthRatio);
      check(heightRatio >= 0.65 && heightRatio <= 1.001,
        `${label}: pełne heksy zachowują czytelną wysokość w canvas`, heightRatio);

      const globalBounds = {
        left: layout.canvas.left + geometry.bounds.left,
        top: layout.canvas.top + geometry.bounds.top,
        right: layout.canvas.left + geometry.bounds.right,
        bottom: layout.canvas.top + geometry.bounds.bottom,
      };
      const renderedBounds = {
        left: Math.min(...geometry.tiles.flatMap(({ vertices }) => vertices.map(({ x }) => x))),
        right: Math.max(...geometry.tiles.flatMap(({ vertices }) => vertices.map(({ x }) => x))),
        top: Math.min(...geometry.tiles.flatMap(({ vertices }) => vertices.map(({ y }) => y))),
        bottom: Math.max(...geometry.tiles.flatMap(({ vertices }) => vertices.map(({ y }) => y))),
      };
      check(["left", "right", "top", "bottom"].every((edge) =>
        Math.abs(renderedBounds[edge] - geometry.bounds[edge]) < 0.001),
      `${label}: wierzchołki wszystkich pól zgadzają się z granicami renderera`,
      { renderedBounds, bounds: geometry.bounds });
      const footprint = geometry.targetFootprint;
      const margins = {
        left: geometry.bounds.left - footprint.left,
        right: footprint.right - geometry.bounds.right,
        top: geometry.bounds.top - footprint.top,
        bottom: footprint.bottom - geometry.bounds.bottom,
      };
      check(Object.values(margins).every((value) => value >= -PIXEL_EPSILON)
        && Math.abs(margins.left - margins.right) <= PIXEL_EPSILON
        && Math.abs(margins.top - margins.bottom) <= PIXEL_EPSILON,
      `${label}: siatka wypełnia dostępny obszar symetrycznie, bez przekrzywienia`, margins);
      check(globalBounds.left >= layout.canvas.left - PIXEL_EPSILON
        && globalBounds.right <= layout.canvas.right + PIXEL_EPSILON
        && globalBounds.top >= layout.canvas.top - PIXEL_EPSILON
        && globalBounds.bottom <= layout.canvas.bottom + PIXEL_EPSILON,
      `${label}: cała plansza pozostaje w aktywnym obszarze kliknięć`, globalBounds);

      const { qx, qy, rx, ry } = geometry.metrics;
      check(geometry.reference.rotationDegrees === 0
        && qx > 0 && qy > 0 && Math.abs(rx) <= 0.001 && ry > 0
        && Math.abs(qy / ry - 0.5) <= 0.001,
      `${label}: kolumny są równomiernie przesunięte, ale plansza nie jest obrócona`, { qx, qy, rx, ry });
      check(Math.abs(qx / geometry.metrics.size - 1.5) <= 0.001
        && Math.abs(ry / geometry.metrics.hexHeight - 1) <= 0.001,
        `${label}: sąsiednie heksy zachowują regularny skok i pełne wspólne krawędzie`, { qx, ry, size: geometry.metrics.size });
      check(Math.abs(geometry.metrics.hexWidth / geometry.metrics.hexHeight - 2 / Math.sqrt(3)) <= 0.002,
        `${label}: proporcja pojedynczego heksa odpowiada wzorowi`, geometry.metrics);

      const outerColumnBounds = (column) => {
        const vertices = geometry.tiles.filter((tile) => tile.column === column)
          .flatMap((tile) => tile.vertices);
        return { top: Math.min(...vertices.map(({ y }) => y)),
          bottom: Math.max(...vertices.map(({ y }) => y)) };
      };
      const leftColumn = outerColumnBounds(0);
      const rightColumn = outerColumnBounds(24);
      check(Math.abs(leftColumn.top - rightColumn.top) <= PIXEL_EPSILON
        && Math.abs(leftColumn.bottom - rightColumn.bottom) <= PIXEL_EPSILON,
      `${label}: lewa i prawa strona siatki mają tę samą wysokość`, { leftColumn, rightColumn });

      const tileByKey = new Map(geometry.tiles.map((tile) => [`${tile.q},${tile.r}`, tile]));
      const badNeighborEdges = [];
      for (const tile of geometry.tiles) {
        for (const [dq, dr] of [[1, 0], [0, 1], [1, -1]]) {
          const neighbor = tileByKey.get(`${tile.q + dq},${tile.r + dr}`);
          if (!neighbor) continue;
          const shared = sharedVertexCount(tile, neighbor);
          if (shared < 2) badNeighborEdges.push({ left: `${tile.q},${tile.r}`, right: `${neighbor.q},${neighbor.r}`, shared });
        }
      }
      check(badNeighborEdges.length === 0,
        `${label}: każdy sąsiadujący heks współdzieli pełną krawędź`, badNeighborEdges.slice(0, 5));

      const brokenRoundTrips = samples.filter(({ q, r, projected, hit }) => (
        !isFinitePoint(projected) || hit?.q !== q || hit?.r !== r
      ));
      check(brokenRoundTrips.length === 0,
        `${label}: projekcja i hit-test zgadzają się dla skrajnych oraz środkowego heksa`, brokenRoundTrips);
      check(centerRoundTripFailures.length === 0 && interiorRoundTripFailures.length === 0,
        `${label}: hit-test trafia wszystkie środki i sześć punktów wewnętrznych każdego heksa`, {
          centers: centerRoundTripFailures.slice(0, 3),
          interiors: interiorRoundTripFailures.slice(0, 3),
        });
      check(clientRoundTripFailures.length === 0,
        `${label}: współrzędne kursora trafiają środek i sześć punktów każdego heksa`,
        clientRoundTripFailures.slice(0, 3));
      check(occupiedAnchorFailures.length === 0,
        `${label}: logiczne kotwice wszystkich jednostek pokrywają środki heksów`,
        occupiedAnchorFailures);

      {
        await waitFor(async () => evaluate(`document.querySelectorAll('.battlefield-shell > .battle-torch .torch-fire-canvas').length === 2`),
          "oddzielne płomienie na obu pochodniach");
        const torchState = () => evaluate(`(() => [...document.querySelectorAll('.battlefield-shell > .battle-torch')]
          .map((torch) => {
            const flame = torch.querySelector('.torch-flame');
            const metal = torch.querySelector('img');
            const canvas = torch.querySelector('.torch-fire-canvas');
            const rect = torch.getBoundingClientRect();
            return { width: rect.width, frame: Number(flame.dataset.flameFrame),
              metalAnimation: getComputedStyle(metal).animationName,
              holderAnimation: getComputedStyle(torch).animationName,
              flameAnimation: getComputedStyle(flame).animationName,
              hasCanvas: canvas?.width === 128 && canvas?.height === 256 };
          }))()`);
        const firstTorchState = await torchState();
        await delay(600);
        const laterTorchState = await torchState();
        check(firstTorchState.length === 2 && laterTorchState.length === 2
          && firstTorchState.every((torch, index) => torch.width <= 149
            && torch.hasCanvas && Number.isInteger(torch.frame)
            && torch.metalAnimation === "none" && torch.holderAnimation === "none"
            && torch.flameAnimation === "none"
            && laterTorchState[index].frame !== torch.frame),
        `${label}: małe pochodnie mają nieruchomy metal i osobne, zmieniające klatki płomienie`,
        { firstTorchState, laterTorchState });
        const interceptedCenters = async () => evaluate(`(() => {
          const canvas = document.querySelector("#scene");
          const rect = canvas.getBoundingClientRect();
          const geometry = window.__rotwDebug.battlefieldGeometry();
          return geometry.tiles.flatMap((tile) => {
            const x = rect.left + tile.center.x * rect.width / geometry.viewport.width;
            const y = rect.top + tile.center.y * rect.height / geometry.viewport.height;
            const element = document.elementFromPoint(x, y);
            return element === canvas ? [] : [{ q: tile.q, r: tile.r,
              target: element?.id || element?.className || element?.tagName || "none",
              startButton: !!element?.closest?.("#start-battle") }];
          });
        })()`);
        const preparationIntercepts = await interceptedCenters();
        check(preparationIntercepts.length === 0,
        `${label}: wszystkie 213 środków docierają do canvas w przygotowaniu`,
        preparationIntercepts);
        const startButtonLabel = await evaluate(`(() => {
          const rect = document.querySelector("#start-battle b").getBoundingClientRect();
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          return { x, y, target: document.elementFromPoint(x, y)?.tagName };
        })()`);
        check(startButtonLabel.target === "B",
          `${label}: napis przycisku startu pozostaje klikalny`, startButtonLabel);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startButtonLabel.x, y: startButtonLabel.y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startButtonLabel.x, y: startButtonLabel.y,
          button: "left", buttons: 1, clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: startButtonLabel.x, y: startButtonLabel.y,
          button: "left", buttons: 0, clickCount: 1 });
        await waitFor(async () => evaluate(`window.__rotwDebug.snapshot().phase === "active"`),
          "rozpoczęcie testowej walki");
        const activeIntercepts = await interceptedCenters();
        check(activeIntercepts.length === 0,
          `${label}: w aktywnej walce wszystkie 213 środków docierają do canvas`,
          activeIntercepts.slice(0, 5));
      }

    }

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1672,
      height: 941,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const diagnosticUrl = new URL(APP_URL);
    diagnosticUrl.searchParams.set("training", "1");
    diagnosticUrl.searchParams.set("grid-debug", "1");
    await cdp.send("Page.navigate", { url: diagnosticUrl.href });
    await waitFor(async () => evaluate(`(() => (
      document.readyState === "complete"
      && document.documentElement.classList.contains("grid-diagnostic")
      && window.__rotwDebug?.battlefieldGeometry()?.tiles?.length
        === window.__rotwDebug?.battlefieldGeometry()?.reference?.totalTiles
    ))()`), "gotowy techniczny podgląd samej siatki");
    const diagnostic = await evaluate(`(() => {
      const geometry = window.__rotwDebug.battlefieldGeometry();
      const canvas = document.querySelector("#scene").getBoundingClientRect();
      return {
        geometry,
        canvas: { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom, width: canvas.width, height: canvas.height },
        hidden: [".top-frame", ".side-panel", ".command-deck", ".scene-vignette"]
          .every((selector) => getComputedStyle(document.querySelector(selector)).display === "none"),
      };
    })()`);
    check(Math.abs(diagnostic.canvas.left) <= PIXEL_EPSILON
      && Math.abs(diagnostic.canvas.top) <= PIXEL_EPSILON
      && Math.abs(diagnostic.canvas.width - 1672) <= PIXEL_EPSILON
      && Math.abs(diagnostic.canvas.height - 941) <= PIXEL_EPSILON,
    "podgląd techniczny używa pełnego płótna 1672×941", diagnostic.canvas);
    check(diagnostic.hidden, "podgląd techniczny pomija postacie, scenerię i cały HUD");
    check(diagnostic.geometry.reference.mode === "approved-v3"
      && diagnostic.geometry.reference.totalTiles === 213
      && diagnostic.geometry.tiles.length === 213
      && diagnostic.geometry.reference.columns === 25
      && diagnostic.geometry.reference.rotationDegrees === 0,
    "podgląd techniczny używa zatwierdzonej, poziomej siatki 213 heksów", diagnostic.geometry.reference);
    check(Math.abs(diagnostic.geometry.bounds.left - 93) <= PIXEL_EPSILON
      && Math.abs(diagnostic.geometry.bounds.right - 1578.8) <= PIXEL_EPSILON
      && Math.abs(diagnostic.geometry.bounds.top - 67) <= PIXEL_EPSILON
      && Math.abs(diagnostic.geometry.bounds.bottom - 676.51) <= PIXEL_EPSILON,
    "podgląd techniczny odpowiada granicom zaakceptowanej makiety 1672×941", diagnostic.geometry.bounds);
    check(diagnostic.geometry.tiles.filter(({ deployment }) => deployment).length === 26,
      "podgląd techniczny zawiera dokładnie 26 pełnych zielonych heksów");
    const diagnosticVerticalBounds = (column) => {
      const vertices = diagnostic.geometry.tiles
        .filter((tile) => tile.column === column)
        .flatMap(({ vertices: tileVertices }) => tileVertices);
      return {
        top: Math.min(...vertices.map(({ y }) => y)),
        bottom: Math.max(...vertices.map(({ y }) => y)),
      };
    };
    const diagnosticLeft = diagnosticVerticalBounds(0);
    const diagnosticRight = diagnosticVerticalBounds(24);
    check(Math.abs(diagnosticLeft.top - diagnosticRight.top) <= PIXEL_EPSILON
      && Math.abs(diagnosticLeft.bottom - diagnosticRight.bottom) <= PIXEL_EPSILON,
    "podgląd techniczny ma identyczny pionowy zakres lewej i prawej strony", {
      left: diagnosticLeft,
      right: diagnosticRight,
    });

    check(runtimeErrors.length === 0, "cały audyt kończy się bez błędów JavaScript", runtimeErrors);
    check(httpErrors.length === 0, "cały audyt kończy się bez odpowiedzi HTTP 4xx/5xx", httpErrors);
    if (failures.length) fail(`${failures.length} z ${assertions.length + failures.length} asercji pola walki nie przeszło`, failures);
    process.stdout.write(`\nPASS BATTLEFIELD: ${assertions.length} asercji w 3 rozdzielczościach i podglądzie referencyjnym, Edge headless, bez widocznego okna.\n`);
  } finally {
    cdp?.close();
    await cleanupTrackedBrowser(edge);
    emergencyBrowser = null;
    emergencyCdp = null;
  }
}

const hardTimeout = setTimeout(async () => {
  process.stderr.write(`FAIL BATTLEFIELD: twardy timeout ${HARD_TIMEOUT_MS} ms\n`);
  emergencyCdp?.close();
  await cleanupTrackedBrowser(emergencyBrowser).catch(() => {});
  process.exit(1);
}, HARD_TIMEOUT_MS);

run().then(() => {
  clearTimeout(hardTimeout);
}).catch((error) => {
  clearTimeout(hardTimeout);
  process.stderr.write(`FAIL BATTLEFIELD: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
