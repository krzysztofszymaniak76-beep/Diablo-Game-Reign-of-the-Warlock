import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
  lifecycleSnapshot,
} from "./browser-lifecycle.mjs";

const APP_URL = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4317/";
const OUT = path.resolve("docs/evidence/v0.5.17");
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = JSON.stringify;
const checks = [];
const errors = [];
let browser;
let socket;
let sequence = 0;
const pending = new Map();

installGlobalCleanupHandlers();

function assert(condition, description, evidence) {
  if (!condition) throw new Error(`${description}: ${json(evidence)}`);
  checks.push(description);
  console.log(`PASS ${description}`);
}

async function send(method, params = {}) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout CDP: ${method}`));
    }, 60_000);
    pending.set(id, { resolve, reject, timeout });
  });
  socket.send(json({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function until(predicate, description, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await predicate().catch(() => null);
    if (result) return result;
    await sleep(75);
  }
  throw new Error(`Timeout: ${description}`);
}

async function click(selector) {
  const result = await evaluate(`(() => {
    const element = document.querySelector(${json(selector)});
    if (!element || element.disabled) return { found: Boolean(element), disabled: element?.disabled };
    element.click();
    return { found: true, disabled: false };
  })()`);
  assert(result?.found && !result.disabled, `Kliknięcie ${selector}`, result);
  await sleep(80);
}

async function stableFrame() {
  await evaluate(`(async () => {
    await document.fonts?.ready;
    const images = Promise.all([...document.images].map((image) => image.complete
      ? image.decode?.().catch(() => {})
      : new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      })));
    await Promise.race([images, new Promise((resolve) => setTimeout(resolve, 8000))]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
}

async function shot(name, width = 1536, height = 864) {
  await stableFrame();
  const screenshot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const file = path.join(OUT, `${name}-${width}x${height}.png`);
  await writeFile(file, Buffer.from(screenshot.data, "base64"));
  console.log(`SCREENSHOT ${file}`);
  return file;
}

async function campaignView(targetAreaId = "act1.den_of_evil") {
  return evaluate(`(async () => {
    const { CampaignState } = await import('/src/core/campaign.js');
    const { shortestSectorPath } = await import('/src/core/exploration.js');
    const state = window.__rotwDebug.snapshot().save.campaign;
    const campaign = CampaignState.restoreAct1(state);
    const map = campaign.act1ExplorationMap();
    const currentSectorId = campaign.act1.exploration.currentSectorId;
    const denExit = map.exits.find((exit) => exit.targetAreaId === ${json(targetAreaId)});
    const graph = new Map(map.sectors.map((sector) => [sector.id, []]));
    for (const edge of map.edges) {
      graph.get(edge.a).push(edge.b);
      graph.get(edge.b).push(edge.a);
    }
    const blocked = new Set(map.encounters.map((item) => item.sectorId));
    const destination = denExit?.sectorId;
    const previous = new Map([[currentSectorId, null]]);
    const queue = [currentSectorId];
    for (let cursor = 0; cursor < queue.length && !previous.has(destination); cursor++) {
      for (const neighbor of graph.get(queue[cursor]) ?? []) {
        if (previous.has(neighbor) || blocked.has(neighbor)) continue;
        previous.set(neighbor, queue[cursor]);
        queue.push(neighbor);
      }
    }
    const safePath = [];
    if (previous.has(destination)) {
      for (let sector = destination; sector !== null; sector = previous.get(sector)) safePath.push(sector);
      safePath.reverse();
    }
    return {
      areaId: campaign.act1.currentAreaId,
      sectorId: currentSectorId,
      sequence: campaign.act1.exploration.movementSequence,
      mapSectorCount: map.sectors.length,
      encounters: map.encounters,
      denExit,
      safePath,
      shortestPath: destination ? shortestSectorPath(map, currentSectorId, destination) : null,
      visibleCards: [...document.querySelectorAll('[data-travel-sector]')]
        .map((item) => item.dataset.travelSector),
      panelOpen: document.querySelector('#panel-layer').getAttribute('aria-hidden') === 'false',
    };
  })()`);
}

async function ensureMap() {
  const isOpen = await evaluate(`document.querySelector('#panel-layer').getAttribute('aria-hidden') === 'false'
    && Boolean(document.querySelector('#exploration-map'))`);
  if (!isOpen) await click('[data-open-panel="map"]');
  await until(() => evaluate("Boolean(document.querySelector('#exploration-map'))"), "mapa eksploracji");
}

async function walkToExit(targetAreaId, maximumClicks = 60) {
  let clicks = 0;
  while (clicks < maximumClicks) {
    await ensureMap();
    const view = await campaignView(targetAreaId);
    if (view.sectorId === view.denExit?.sectorId) return clicks;
    assert(view.safePath.length > 1, `Droga do ${targetAreaId} omija spotkania`, view);
    const next = view.safePath[1];
    assert(view.visibleCards.includes(next), `Dostępna karta do ${next}`, view.visibleCards);
    await click(`[data-travel-sector="${next}"]`);
    clicks += 1;
    await until(async () => (await campaignView(targetAreaId)).sectorId !== view.sectorId,
      `ruch do ${next}`);
  }
  throw new Error(`Przekroczono limit podróży do ${targetAreaId}`);
}

async function run() {
  const health = await (await fetch(new URL("/__rotw_health", APP_URL), {
    signal: AbortSignal.timeout(5_000),
  })).json();
  assert(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    "Serwer udostępnia projekt D2", health);
  const lifecycle = await lifecycleSnapshot();
  assert(lifecycle.owned.length < lifecycle.maxRoots, "Dostępny slot izolowanej przeglądarki", lifecycle.owned.length);

  browser = await launchTrackedBrowser({
    edgePath: EDGE,
    appUrl: "about:blank",
    windowSize: "1536,864",
    stdio: ["ignore", "ignore", "pipe"],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  assert(Boolean(target?.webSocketDebuggerUrl), "Przeglądarka udostępnia kartę testową");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", async (event) => {
    let raw = event.data;
    if (typeof raw !== "string" && typeof raw?.text === "function") raw = await raw.text();
    const message = JSON.parse(String(raw));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === "Runtime.consoleAPICalled"
      && ["error", "assert"].includes(message.params.type)) {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1536, height: 864, deviceScaleFactor: 1, mobile: false,
  });
  const address = new URL(APP_URL);
  address.searchParams.set("acceptance", "v0.5.17");
  await send("Page.navigate", { url: address.href });
  await until(() => evaluate("Boolean(window.__rotwDebug?.snapshot) && document.readyState === 'complete'"),
    "start gry");
  await until(() => evaluate("document.querySelector('#team-selection-layer').getAttribute('aria-hidden') === 'false'"),
    "wybór bohaterów");
  const choices = await evaluate(`(() => ({
    cards: [...document.querySelectorAll('#team-selection-grid [role="option"]')].map((card) => ({
      id: card.dataset.heroId, name: card.querySelector('img')?.alt, loaded: card.querySelector('img')?.naturalWidth > 0,
    })),
    viewport: [innerWidth, innerHeight],
  }))()`);
  assert(choices.cards.length === 8 && choices.cards.every((card) => card.loaded),
    "Osiem kart postaci ma załadowane obrazy", choices);
  await shot("team-selection");
  if (process.argv.includes("--selection-only")) {
    for (const { width, height } of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      const layout = await evaluate(`(() => ({
        viewport: [innerWidth, innerHeight],
        cards: [...document.querySelectorAll('#team-selection-grid [role="option"]')].map((card) => {
          const box = card.getBoundingClientRect();
          return { id: card.dataset.heroId, top: box.top, bottom: box.bottom,
            overflow: card.scrollHeight - card.clientHeight };
        }),
      }))()`);
      assert(layout.viewport[0] === width && layout.viewport[1] === height
        && layout.cards.length === 8 && layout.cards.every((card) => card.overflow <= 1),
      `Osiem kart mieści treść ${width}x${height}`, layout);
      await shot("team-selection", width, height);
    }
    return;
  }

  const selected = await evaluate("[...document.querySelectorAll('#team-selection-grid [aria-selected=\"true\"]')].map((item) => item.dataset.heroId)");
  for (const id of selected) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  for (const id of ["korgan", "mael", "veyran"]) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  await click("#team-selection-confirm");
  await until(() => evaluate("document.querySelector('#camp-layer').getAttribute('aria-hidden') === 'false'"),
    "obóz po zatwierdzeniu drużyny");
  const camp = await evaluate(`(() => ({
    title: document.querySelector('.camp-location-plaque strong')?.textContent.trim(),
    heroes: window.__rotwDebug.snapshot().save.partyIds,
    hotspots: [...document.querySelectorAll('#camp-layer [data-camp-action]:not(.hidden)')].map((item) => item.dataset.campAction),
  }))()`);
  assert(camp.heroes.join(",") === "korgan,mael,veyran" && camp.hotspots.length >= 8,
    "Obóz pokazuje wybraną drużynę i hotspoty", camp);
  await shot("rogue-encampment");

  await click('[data-camp-action="akara"]');
  await until(() => evaluate("document.querySelector('#panel-title').textContent.trim() === 'AKARA'"), "rozmowa z Akarą");
  await shot("akara-dialogue");
  await click("#akara-accept");
  assert((await evaluate("window.__rotwDebug.snapshot().save.campaign.questState['act1.den_of_evil']?.status")) === "active",
    "Akara przyjmuje zadanie Siedliska Zła");
  await click("#close-panel");

  await click('[data-camp-action="charsi"]');
  await until(() => evaluate("document.querySelector('#panel-title').textContent.trim() === 'HANDEL · CHARSI'"), "handel Charsi");
  assert((await evaluate("document.querySelectorAll('.camp-offer-list .loot-row').length")) > 0,
    "Charsi ma ofertę handlową");
  await shot("charsi-trade");
  const beforePurchase = await evaluate("window.__rotwDebug.snapshot().save");
  const offer = beforePurchase.campServices.vendors.find((vendor) => vendor.id === "charsi")?.offers[0];
  const ownerId = beforePurchase.inspectedCharacterId;
  assert(Boolean(offer && ownerId), "Zakup ma ofertę i właściciela", { offer, ownerId });
  await click(".camp-offer-list .loot-row button");
  const afterPurchase = await until(async () => {
    const save = await evaluate("window.__rotwDebug.snapshot().save");
    return save.inventories.find(([id]) => id === ownerId)?.[1].items.some((item) => item.id === offer.item.id)
      ? save : null;
  }, "przedmiot kupiony u Charsi");
  assert(afterPurchase.campServices.gold === beforePurchase.campServices.gold - offer.buyPrice,
    "Zakup odejmuje cenę i zachowuje identyfikator", { before: beforePurchase.campServices.gold,
      after: afterPurchase.campServices.gold, price: offer.buyPrice });
  await click("#close-panel");

  await click('[data-camp-action="stash"]');
  await until(() => evaluate("document.querySelector('#panel-title').textContent.trim() === 'WSPÓLNA SKRYTKA'"),
    "skrytka w obozie");
  const purchasedIndex = afterPurchase.inventories.find(([id]) => id === ownerId)[1]
    .items.findIndex((item) => item.id === offer.item.id);
  const moveToStash = await evaluate(`(() => {
    const row = document.querySelector('#panel-body .loot-list')?.querySelectorAll('.loot-row')[${purchasedIndex}];
    if (!row?.querySelector('button')?.textContent.includes('DO SKRYTKI')) return false;
    row?.querySelector('button')?.click();
    return Boolean(row);
  })()`);
  assert(moveToStash, "Przycisk przenosi kupiony przedmiot do skrytki");
  await until(async () => (await evaluate("window.__rotwDebug.snapshot().save"))
    .campServices.stash.items.some((item) => item.id === offer.item.id),
  "przedmiot w skrytce");
  const moveFromStash = await evaluate(`(() => {
    const row = document.querySelectorAll('#panel-body .loot-list')[1]?.querySelector('.loot-row');
    if (!row?.querySelector('button')?.textContent.includes('DO PLECAKA')) return false;
    row?.querySelector('button')?.click();
    return Boolean(row);
  })()`);
  assert(moveFromStash, "Przycisk przenosi przedmiot ze skrytki do plecaka");
  const afterStash = await until(async () => {
    const save = await evaluate("window.__rotwDebug.snapshot().save");
    return save.inventories.find(([id]) => id === ownerId)?.[1].items.some((item) => item.id === offer.item.id)
      && !save.campServices.stash.items.some((item) => item.id === offer.item.id) ? save : null;
  }, "powrót przedmiotu do plecaka");
  assert(afterStash.campServices.gold === afterPurchase.campServices.gold,
    "Obieg skrytki zachowuje złoto i przedmiot");
  await click("#close-panel");

  await click('[data-camp-action="gate"]');
  await until(() => evaluate("window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId === 'act1.blood_moor'"),
    "przejście do Krwawego Wrzosowiska");
  await ensureMap();
  const before = await campaignView();
  assert(before.areaId === "act1.blood_moor" && before.safePath.length > 1,
    "Mapa ma legalną trasę bez spotkania do Siedliska", before);
  await shot("blood-moor-before-move");
  let moved = false;
  let travelClicks = 0;
  while (travelClicks < 60) {
    await ensureMap();
    const view = await campaignView();
    if (view.sectorId === view.denExit.sectorId) break;
    assert(view.safePath.length > 1, "Następny krok bez spotkania", view);
    const next = view.safePath[1];
    assert(view.visibleCards.includes(next), "Dostępna legalna karta podróży", { next, cards: view.visibleCards });
    await click(`[data-travel-sector="${next}"]`);
    travelClicks += 1;
    await until(async () => (await campaignView()).sectorId !== view.sectorId, `przejście do ${next}`);
    const after = await campaignView();
    assert(after.areaId === "act1.blood_moor" && after.sequence > view.sequence,
      "Podróż zmienia sektor przez interfejs", { before: view, after });
    if (!moved) {
      await shot("blood-moor-after-move");
      moved = true;
    }
  }
  const entrance = await campaignView();
  assert(entrance.sectorId === entrance.denExit.sectorId && travelClicks < 60,
    "Drużyna dociera do wejścia Siedliska", entrance);
  assert(await evaluate("Boolean(document.querySelector('[data-area-exit=\"act1.den_of_evil\"]:not([disabled])'))"),
    "Wejście do Siedliska jest dostępne po dotarciu");
  await shot("den-entrance");
  await click('[data-area-exit="act1.den_of_evil"]');
  await until(() => evaluate("window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId === 'act1.den_of_evil'"),
    "wejście do Siedliska Zła");
  await ensureMap();
  await shot("den-interior-entry");
  let denMoves = 0;
  for (let step = 0; step < 4; step++) {
    const option = await evaluate(`(async () => {
      const { CampaignState } = await import('/src/core/campaign.js');
      const campaign = CampaignState.restoreAct1(window.__rotwDebug.snapshot().save.campaign);
      const map = campaign.act1ExplorationMap();
      const blocked = new Set(map.encounters.map((item) => item.sectorId));
      const view = campaign.act1ExplorationView();
      return view.sectors.find((sector) => sector.reachable && !sector.discovered
        && !blocked.has(sector.id) && !sector.exits.length)?.id ?? null;
    })()`);
    if (!option) break;
    const previous = await campaignView();
    assert(previous.visibleCards.includes(option), "Wnętrze ma dostępną kartę drogi", option);
    await click(`[data-travel-sector="${option}"]`);
    await until(async () => (await campaignView()).sectorId !== previous.sectorId,
      `ruch w Siedlisku do ${option}`);
    denMoves += 1;
  }
  assert((await campaignView()).areaId === "act1.den_of_evil", "Drużyna pozostaje w Siedlisku Zła");
  await shot("den-interior-after-move");
  const beforeReload = await evaluate("window.__rotwDebug.snapshot().save.campaign");
  await click("#close-panel");
  await click("#save");
  await click("#load");
  await until(async () => JSON.stringify(await evaluate("window.__rotwDebug.snapshot().save.campaign"))
    === JSON.stringify(beforeReload), "wczytanie po podróży po Siedlisku");
  assert((await evaluate("window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId")) === "act1.den_of_evil",
    "Zapis i wczytanie zachowują położenie w Siedlisku");
  await ensureMap();
  const denReturnClicks = await walkToExit("act1.blood_moor");
  assert(await evaluate("Boolean(document.querySelector('[data-area-exit=\"act1.blood_moor\"]:not([disabled])'))"),
    "Wyjście z Siedliska jest legalne");
  await click('[data-area-exit="act1.blood_moor"]');
  await until(() => evaluate("window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId === 'act1.blood_moor'"),
    "powrót na Krwawe Wrzosowisko");
  const moorReturnClicks = await walkToExit("act1.rogue_encampment");
  assert(await evaluate("Boolean(document.querySelector('[data-area-exit=\"act1.rogue_encampment\"]:not([disabled])'))"),
    "Wyjście do obozu jest legalne");
  await click('[data-area-exit="act1.rogue_encampment"]');
  await until(() => evaluate("window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId === 'act1.rogue_encampment'"),
    "powrót do Obozowiska Łotrzyc");
  assert(await evaluate("document.querySelector('#camp-layer').getAttribute('aria-hidden') === 'false'"),
    "Po powrocie pojawia się obóz");
  await shot("rogue-encampment-after-return");

  await click("#camp-open-team");
  const chosen = await evaluate("[...document.querySelectorAll('#team-selection-grid [aria-selected=\"true\"]')].map((item) => item.dataset.heroId)");
  for (const id of chosen) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  for (const id of ["cassia", "natalya", "isendra"]) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  await click("#team-selection-confirm");
  assert((await evaluate("window.__rotwDebug.snapshot().save.partyIds"))?.join(",") === "cassia,natalya,isendra",
    "Zmiana drużyny po powrocie zachowuje nową trójkę");
  const beforeCampSave = await evaluate("window.__rotwDebug.snapshot().save");
  await click("#camp-save");
  await click("#camp-load");
  const afterCampLoad = await evaluate("window.__rotwDebug.snapshot().save");
  assert(JSON.stringify(afterCampLoad.campaign) === JSON.stringify(beforeCampSave.campaign)
    && afterCampLoad.partyIds.join(",") === beforeCampSave.partyIds.join(",")
    && afterCampLoad.campServices.gold === beforeCampSave.campServices.gold,
  "Zapis i wczytanie w obozie zachowują trasę, skład i złoto");
  assert(errors.length === 0, "Brak błędów konsoli", errors);
  await writeFile(path.join(OUT, "ui-v0517-acceptance.json"), json({
    result: "PASS", viewport: "1536x864", checks,
    route: { bloodMoorClicks: travelClicks, denMoves, denReturnClicks, moorReturnClicks }, errors,
  }, null, 2));
}

let failed;
try {
  await mkdir(OUT, { recursive: true });
  await run();
} catch (error) {
  failed = error;
  await writeFile(path.join(OUT, "ui-v0517-acceptance.json"), json({
    result: "FAIL", checks, errors, failure: error.stack ?? error.message,
  }, null, 2)).catch(() => {});
} finally {
  for (const request of pending.values()) clearTimeout(request.timeout);
  socket?.close();
  const cleanup = browser ? await cleanupTrackedBrowser(browser) : null;
  if (cleanup?.remaining?.length && !failed) failed = new Error("Pozostały procesy przeglądarki testowej");
  console.log(`BROWSER_CLEANUP ${json({ rootPid: cleanup?.rootPid, remaining: cleanup?.remaining?.length ?? 0 })}`);
}
if (failed) {
  console.error(failed.stack ?? failed.message);
  process.exitCode = 1;
} else {
  console.log(`PASS ui-v0517-acceptance ${checks.length} checks`);
}
