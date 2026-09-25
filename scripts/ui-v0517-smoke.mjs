import path from "node:path";
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
} from "./browser-lifecycle.mjs";

const APP_URL = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4317/";
const EDGE_PATH = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const STEP_TIMEOUT_MS = 15_000;
const EXPECTED_CLASSES = [
  "amazon",
  "assassin",
  "barbarian",
  "druid",
  "necromancer",
  "paladin",
  "sorceress",
  "warlock",
];
const EXPECTED_HOTSPOTS = ["akara", "charsi", "gate", "gheed", "kashya", "stash", "warriv", "waypoint"];

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const json = (value) => JSON.stringify(value);
const checks = [];
const consoleErrors = [];
let trackedBrowser = null;
let cdp = null;

installGlobalCleanupHandlers();

function check(condition, label, detail) {
  if (!condition) {
    const suffix = detail === undefined ? "" : `\n  ${typeof detail === "string" ? detail : json(detail)}`;
    throw new Error(`${label}${suffix}`);
  }
  checks.push(label);
  console.log(`PASS ${label}`);
}

function equal(actual, expected, label) {
  check(json(actual) === json(expected), label, { actual, expected });
}

async function waitFor(probe, label, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(60);
  }
  throw new Error(`Timeout: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout połączenia CDP")), STEP_TIMEOUT_MS);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Nie udało się połączyć z CDP"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.#onMessage(event.data));
    this.socket.addEventListener("close", () => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(new Error("Połączenie CDP zostało zamknięte"));
      }
      this.pending.clear();
    });
  }

  async #onMessage(raw) {
    let payload = raw;
    if (typeof payload !== "string" && typeof payload?.text === "function") payload = await payload.text();
    else if (payload instanceof ArrayBuffer) payload = Buffer.from(payload).toString("utf8");
    else if (ArrayBuffer.isView(payload)) {
      payload = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
    }
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
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout CDP: ${method}`));
      }, STEP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.socket.send(json({ id, method, params }));
    return result;
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // The tracked browser cleanup owns the process tree.
    }
  }
}

async function evaluate(expression) {
  const response = await cdp.send("Runtime.evaluate", {
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

const snapshot = () => evaluate("window.__rotwDebug.snapshot()");

async function click(selector) {
  const result = await evaluate(`(() => {
    const element = document.querySelector(${json(selector)});
    if (!element) return { ok: false, reason: "missing" };
    if (element.disabled) return { ok: false, reason: "disabled" };
    element.click();
    return { ok: true };
  })()`);
  if (!result?.ok) throw new Error(`Nie można kliknąć ${selector}: ${result?.reason ?? "unknown"}`);
  await delay(80);
}

async function closePanel() {
  await click("#close-panel");
  await waitFor(
    () => evaluate("document.querySelector('#panel-layer').getAttribute('aria-hidden') === 'true'"),
    "zamknięcie panelu",
  );
}

async function chooseTeam(ids, { limitProbeId = null } = {}) {
  const selected = await evaluate(`[...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]
    .map((button) => button.dataset.heroId)`);
  for (const id of selected) await click(`#team-selection-grid [data-hero-id="${id}"]`);

  const empty = await evaluate(`(() => ({
    selected: document.querySelectorAll('#team-selection-grid [aria-selected="true"]').length,
    disabled: document.querySelector('#team-selection-confirm').disabled,
  }))()`);
  check(empty.selected === 0 && empty.disabled, "selektor wymaga dokładnie trzech postaci", empty);

  for (const id of ids) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  if (limitProbeId) await click(`#team-selection-grid [data-hero-id="${limitProbeId}"]`);

  const ready = await evaluate(`(() => ({
    selected: [...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]
      .map((button) => button.dataset.heroId),
    pressedMatches: [...document.querySelectorAll('#team-selection-grid [role="option"]')]
      .every((button) => button.getAttribute('aria-selected') === button.getAttribute('aria-pressed')),
    slots: [...document.querySelectorAll('[data-team-slot] strong')].map((slot) => slot.textContent.trim()),
    disabled: document.querySelector('#team-selection-confirm').disabled,
    rule: document.querySelector('.team-selection-rule b').textContent.trim(),
  }))()`);
  equal([...ready.selected].sort(), [...ids].sort(),
    "selektor zachowuje wybraną trójkę i blokuje czwartą postać");
  check(ready.pressedMatches && !ready.disabled && ready.rule === "3 / 8"
    && ready.slots.every((slot) => slot !== "Wolne miejsce"), "wybór trzech jest spójny w DOM i ARIA", ready);

  await click("#team-selection-confirm");
  await waitFor(
    () => evaluate("document.querySelector('#team-selection-layer').getAttribute('aria-hidden') === 'true'"),
    "zatwierdzenie drużyny",
  );
}

async function inspectCampPanel(action, expectedTitle) {
  await click(`[data-camp-action="${action}"]`);
  await waitFor(
    () => evaluate(`document.querySelector('#panel-layer').getAttribute('aria-hidden') === 'false'
      && document.querySelector('#panel-title').textContent.trim() === ${json(expectedTitle)}`),
    `panel hotspotu ${action}`,
  );
  checks.push(`hotspot ${action} otwiera panel ${expectedTitle}`);
  console.log(`PASS hotspot ${action} otwiera panel ${expectedTitle}`);
  await closePanel();
}

function inventoryOf(save, ownerId) {
  return save.inventories.find(([id]) => id === ownerId)?.[1];
}

function itemIdentity(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "position"));
}

function ownershipIds(save) {
  const ids = [];
  for (const [, inventory] of save.inventories) ids.push(...inventory.items.map(({ id }) => id));
  ids.push(...save.campServices.stash.items.map(({ id }) => id));
  for (const vendor of save.campServices.vendors) {
    ids.push(...vendor.offers.map(({ item }) => item.id));
  }
  return ids;
}

async function runSmoke() {
  const healthUrl = new URL("/__rotw_health", APP_URL);
  const healthResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
  check(healthResponse.ok, "serwer 4317 odpowiada na health check", healthResponse.status);
  const health = await healthResponse.json();
  check(health.app === "reign-of-the-warlock-turn-based", "health check wskazuje właściwą aplikację", health);
  check(
    path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    "serwer 4317 udostępnia bieżący projekt D2",
    health,
  );

  trackedBrowser = await launchTrackedBrowser({
    edgePath: EDGE_PATH,
    appUrl: "about:blank",
    windowSize: "1536,864",
    stdio: ["ignore", "ignore", "pipe"],
  });
  const targets = await (await fetch(`http://127.0.0.1:${trackedBrowser.port}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  })).json();
  const target = targets.find((entry) => entry.type === "page");
  check(Boolean(target?.webSocketDebuggerUrl), "izolowany headless Chromium udostępnia kartę CDP", target);

  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    consoleErrors.push(`exception: ${exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? "unknown"}`);
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
    if (!["error", "assert"].includes(type)) return;
    consoleErrors.push(`console.${type}: ${args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ")}`);
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (entry?.level === "error") consoleErrors.push(`log: ${entry.text}`);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1536,
    height: 864,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const smokeUrl = new URL(APP_URL);
  smokeUrl.searchParams.set("ui-v0517-smoke", "1");
  await cdp.send("Page.navigate", { url: smokeUrl.href });
  await waitFor(
    () => evaluate("Boolean(window.__rotwDebug?.snapshot) && document.readyState === 'complete'"),
    "uruchomienie aplikacji",
  );
  await waitFor(
    () => evaluate("document.querySelector('#team-selection-layer').getAttribute('aria-hidden') === 'false'"),
    "obowiązkowy selektor drużyny",
  );

  const selector = await evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    const classes = new Map(save.roster.map((hero) => [hero.id, hero.classId]));
    const cards = [...document.querySelectorAll('#team-selection-grid [role="option"]')];
    return {
      visible: !document.querySelector('#team-selection-layer').classList.contains('hidden'),
      count: cards.length,
      ids: cards.map((card) => card.dataset.heroId),
      classes: cards.map((card) => classes.get(card.dataset.heroId)).sort(),
      names: cards.map((card) => card.querySelector('img')?.alt ?? ''),
      selected: cards.filter((card) => card.getAttribute('aria-selected') === 'true').length,
      uniqueIds: new Set(cards.map((card) => card.dataset.heroId)).size,
      allButtons: cards.every((card) => card.tagName === 'BUTTON' && card.type === 'button'),
    };
  })()`);
  check(selector.visible && selector.count === 8 && selector.uniqueIds === 8 && selector.allButtons,
    "selektor renderuje osiem unikalnych kart postaci", selector);
  equal(selector.classes, EXPECTED_CLASSES, "selektor obejmuje osiem klas v0.5.17");
  check(selector.names.every(Boolean) && selector.selected === 3,
    "karty mają nazwy dostępnościowe i początkową aktywną trójkę", selector);

  await chooseTeam(["mael", "cassia", "natalya"], { limitProbeId: "isendra" });
  let current = await snapshot();
  equal(current.save.partyIds, ["mael", "cassia", "natalya"], "pierwsza wybrana trójka trafia do autorytatywnego stanu");

  const camp = await evaluate(`(() => {
    const layer = document.querySelector('#camp-layer');
    const rows = [...layer.querySelectorAll('[data-camp-action]')].map((button) => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        action: button.dataset.campAction,
        hidden: button.classList.contains('hidden') || style.display === 'none' || style.visibility === 'hidden',
        type: button.type,
        label: button.getAttribute('aria-label'),
        inside: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
          && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      };
    });
    return {
      visible: !layer.classList.contains('hidden') && layer.getAttribute('aria-hidden') === 'false',
      campMode: document.querySelector('#app').classList.contains('camp-mode'),
      visibleActions: rows.filter((row) => !row.hidden).map((row) => row.action).sort(),
      cainHidden: rows.find((row) => row.action === 'cain')?.hidden,
      controlsValid: rows.filter((row) => !row.hidden)
        .every((row) => row.type === 'button' && Boolean(row.label) && row.inside),
    };
  })()`);
  equal(camp.visibleActions, EXPECTED_HOTSPOTS, "obóz pokazuje komplet ośmiu aktywnych hotspotów");
  check(camp.visible && camp.campMode && camp.cainHidden && camp.controlsValid,
    "warstwa obozu i hotspoty są widoczne, dostępne i mieszczą się w kadrze", camp);

  const beforeCampChange = current.save;
  await click("#camp-open-team");
  await waitFor(
    () => evaluate("document.querySelector('#team-selection-layer').getAttribute('aria-hidden') === 'false'"),
    "ponowne otwarcie selektora w obozie",
  );
  const optionalSelector = await evaluate("!document.querySelector('#team-selection-cancel').hidden");
  check(optionalSelector, "ponowną zmianę składu w obozie można anulować");
  await chooseTeam(["isendra", "veyran", "hadriel"], { limitProbeId: "korgan" });
  current = await snapshot();
  equal(current.save.partyIds, ["isendra", "veyran", "hadriel"], "bezpieczny obóz zatwierdza nową aktywną trójkę");
  equal(current.save.roster, beforeCampChange.roster, "zmiana drużyny nie odnawia ani nie zmienia bohaterów");
  equal(current.save.inventories, beforeCampChange.inventories, "zmiana drużyny zachowuje plecaki i tożsamość przedmiotów");
  equal(current.save.campaign, beforeCampChange.campaign, "zmiana drużyny zachowuje postęp kampanii");
  equal(current.save.campServices, beforeCampChange.campServices, "zmiana drużyny zachowuje usługi obozu");

  await inspectCampPanel("akara", "AKARA");
  await inspectCampPanel("kashya", "KASHYA");
  await inspectCampPanel("gheed", "HANDEL · GHEED");
  await inspectCampPanel("warriv", "WARRIV");

  const beforePurchase = (await snapshot()).save;
  const ownerId = beforePurchase.inspectedCharacterId;
  const vendorBefore = beforePurchase.campServices.vendors.find(({ id }) => id === "charsi");
  const offer = vendorBefore?.offers[0];
  check(Boolean(ownerId && offer), "Charsi ma rzeczywistą ofertę dla oglądanej postaci", { ownerId, vendorBefore });
  const ownerItemsBefore = inventoryOf(beforePurchase, ownerId).items;

  await click('[data-camp-action="charsi"]');
  await waitFor(
    () => evaluate("document.querySelector('#panel-title').textContent.trim() === 'HANDEL · CHARSI'"),
    "panel handlu Charsi",
  );
  const buyControl = await evaluate(`(() => {
    const button = document.querySelector('.camp-offer-list .loot-row button');
    return button ? { text: button.textContent.trim(), disabled: button.disabled } : null;
  })()`);
  check(buyControl && !buyControl.disabled && buyControl.text.includes(String(offer.buyPrice)),
    "oferta Charsi pokazuje aktywny zakup z prawidłową ceną", buyControl);
  await click(".camp-offer-list .loot-row button");
  await waitFor(async () => {
    const save = (await snapshot()).save;
    return inventoryOf(save, ownerId).items.some(({ id }) => id === offer.item.id);
  }, "zakup przedmiotu Charsi");

  const afterPurchase = (await snapshot()).save;
  const purchased = inventoryOf(afterPurchase, ownerId).items.find(({ id }) => id === offer.item.id);
  check(afterPurchase.campServices.gold === beforePurchase.campServices.gold - offer.buyPrice,
    "realny zakup odejmuje dokładną cenę od złota", {
      before: beforePurchase.campServices.gold,
      after: afterPurchase.campServices.gold,
      price: offer.buyPrice,
    });
  check(inventoryOf(afterPurchase, ownerId).items.length === ownerItemsBefore.length + 1
    && !afterPurchase.campServices.vendors.find(({ id }) => id === "charsi").offers
      .some(({ offerId }) => offerId === offer.offerId),
  "zakup przenosi tę samą ofertę z handlarza do plecaka", { offer, purchased });
  equal(itemIdentity(purchased), itemIdentity(offer.item), "zakup zachowuje tożsamość i dane przedmiotu");
  const idsAfterPurchase = ownershipIds(afterPurchase);
  check(new Set(idsAfterPurchase).size === idsAfterPurchase.length,
    "zakup nie duplikuje własności przedmiotów", idsAfterPurchase);
  await closePanel();

  await click('[data-camp-action="stash"]');
  await waitFor(
    () => evaluate("document.querySelector('#panel-title').textContent.trim() === 'WSPÓLNA SKRYTKA'"),
    "panel wspólnej skrytki",
  );
  const movedToStash = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#panel-body .loot-row')].find((candidate) =>
      candidate.querySelector('h3')?.textContent.trim() === ${json(purchased.name)}
      && candidate.querySelector('button')?.textContent.includes('DO SKRYTKI'));
    if (!row) return false;
    row.querySelector('button').click();
    return true;
  })()`);
  check(movedToStash, "kupiony przedmiot jest dostępny do przeniesienia do skrytki");
  await waitFor(async () => {
    const save = (await snapshot()).save;
    return save.campServices.stash.items.some(({ id }) => id === purchased.id);
  }, "przeniesienie przedmiotu do skrytki");
  const inStash = (await snapshot()).save;
  const stashed = inStash.campServices.stash.items.find(({ id }) => id === purchased.id);
  check(!inventoryOf(inStash, ownerId).items.some(({ id }) => id === purchased.id),
    "przeniesienie usuwa przedmiot z plecaka");
  equal(itemIdentity(stashed), itemIdentity(purchased), "skrytka zachowuje tożsamość przedmiotu");

  const movedFromStash = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#panel-body .loot-row')].find((candidate) =>
      candidate.querySelector('h3')?.textContent.trim() === ${json(purchased.name)}
      && candidate.querySelector('button')?.textContent.includes('DO PLECAKA'));
    if (!row) return false;
    row.querySelector('button').click();
    return true;
  })()`);
  check(movedFromStash, "przedmiot jest dostępny do wyjęcia ze skrytki");
  await waitFor(async () => {
    const save = (await snapshot()).save;
    return inventoryOf(save, ownerId).items.some(({ id }) => id === purchased.id)
      && !save.campServices.stash.items.some(({ id }) => id === purchased.id);
  }, "powrót przedmiotu ze skrytki do plecaka");
  const afterStash = (await snapshot()).save;
  const returned = inventoryOf(afterStash, ownerId).items.find(({ id }) => id === purchased.id);
  equal(itemIdentity(returned), itemIdentity(purchased), "wyjęcie ze skrytki zachowuje tożsamość przedmiotu");
  const idsAfterStash = ownershipIds(afterStash);
  check(new Set(idsAfterStash).size === idsAfterStash.length,
    "pełny obieg skrytki nie duplikuje przedmiotów", idsAfterStash);
  await closePanel();

  await click("#camp-open-map");
  await waitFor(
    () => evaluate("document.querySelector('#panel-title').textContent.trim() === 'MAPA EKSPLORACJI'"),
    "mapa obozu",
  );
  const waypointRoute = await evaluate(`(async () => {
    const { CampaignState } = await import('/src/core/campaign.js');
    const { shortestSectorPath } = await import('/src/core/exploration.js');
    const campaign = CampaignState.restoreAct1(window.__rotwDebug.snapshot().save.campaign);
    const map = campaign.act1ExplorationMap();
    const waypoint = map.points.find((point) => point.kind === 'waypoint');
    return {
      areaId: campaign.act1.currentAreaId,
      waypoint,
      path: shortestSectorPath(map, campaign.act1.exploration.currentSectorId, waypoint.sectorId),
    };
  })()`);
  check(waypointRoute.areaId === "act1.rogue_encampment" && waypointRoute.waypoint
    && waypointRoute.path?.length > 1, "mapa obozu wyznacza realną trasę do waypointu", waypointRoute);

  for (const sectorId of waypointRoute.path.slice(1)) {
    const moved = await evaluate(`(() => {
      const sector = document.querySelector('[data-sector-id="${sectorId}"]');
      if (!sector) return false;
      sector.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return true;
    })()`);
    check(moved, `mapa pozwala przejść do ${sectorId}`);
    await waitFor(
      async () => (await snapshot()).save.campaign.act1.exploration.currentSectorId === sectorId,
      `ruch mapy do ${sectorId}`,
    );
  }
  await waitFor(
    () => evaluate("Boolean(document.querySelector('#activate-waypoint:not([disabled])'))"),
    "aktywacja waypointu w jego sektorze",
  );
  await click("#activate-waypoint");
  const waypointState = (await snapshot()).save.campaign;
  check(waypointState.waypoints["act1.rogue_encampment"] === true
    && waypointState.act1.exploration.areaStates["act1.rogue_encampment"].activatedWaypointIds
      .includes(waypointRoute.waypoint.id), "waypoint obozu aktywuje zapisane potwierdzenie", waypointState.waypoints);
  await closePanel();

  await click('[data-camp-action="waypoint"]');
  await waitFor(
    () => evaluate("document.querySelector('#panel-title').textContent.trim() === 'PUNKT NAWIGACYJNY'"),
    "hotspot aktywowanego waypointu",
  );
  const waypointPanel = await evaluate(`(() => ({
    current: [...document.querySelectorAll('#panel-body .loot-row')].some((row) =>
      row.querySelector('h3')?.textContent.includes('Obozowisko')
      && row.querySelector('button')?.disabled
      && row.querySelector('button')?.textContent.includes('JESTEŚ TUTAJ')),
    active: [...document.querySelectorAll('#panel-body button')].some((button) =>
      button.textContent.includes('BIEŻĄCY WAYPOINT AKTYWNY') && button.disabled),
  }))()`);
  check(waypointPanel.current && waypointPanel.active,
    "hotspot waypointu pokazuje wyłącznie rzeczywiście aktywowany bieżący punkt", waypointPanel);
  await closePanel();

  const beforeGate = (await snapshot()).save;
  await click('[data-camp-action="gate"]');
  await waitFor(
    async () => (await snapshot()).save.campaign.act1.currentAreaId === "act1.blood_moor",
    "przejście przez bramę obozu",
  );
  const afterGate = (await snapshot()).save;
  const gateUi = await evaluate(`(() => ({
    campHidden: document.querySelector('#camp-layer').classList.contains('hidden'),
    campAria: document.querySelector('#camp-layer').getAttribute('aria-hidden'),
    campMode: document.querySelector('#app').classList.contains('camp-mode'),
  }))()`);
  check(gateUi.campHidden && gateUi.campAria === "true" && !gateUi.campMode,
    "brama przełącza interfejs z obozu na Krwawe Wrzosowisko", gateUi);
  equal(afterGate.roster, beforeGate.roster, "brama zachowuje stan bohaterów");
  equal(afterGate.inventories, beforeGate.inventories, "brama zachowuje plecaki");
  equal(afterGate.campServices, beforeGate.campServices, "brama zachowuje zakup, skrytkę i złoto");

  const partyBeforeUnsafeChange = [...afterGate.partyIds];
  await evaluate("document.querySelector('#camp-open-team').click()");
  await delay(100);
  const unsafeChange = await evaluate(`(() => ({
    chooserHidden: document.querySelector('#team-selection-layer').getAttribute('aria-hidden') === 'true',
    toast: document.querySelector('#game-toast').textContent.trim(),
  }))()`);
  const afterUnsafeChange = (await snapshot()).save;
  equal(afterUnsafeChange.partyIds, partyBeforeUnsafeChange,
    "poza bezpiecznym obozem próba zmiany drużyny nie zmienia składu");
  check(unsafeChange.chooserHidden && unsafeChange.toast.includes("wyłącznie w bezpiecznym obozie"),
    "poza obozem selektor pozostaje zamknięty i wyjaśnia blokadę", unsafeChange);

  await delay(250);
  check(consoleErrors.length === 0, "brak wyjątków i błędów konsoli podczas pełnego smoke", consoleErrors);
}

let failure = null;
let cleanup = null;
try {
  await runSmoke();
} catch (error) {
  failure = error;
} finally {
  cdp?.close();
  cleanup = trackedBrowser ? await cleanupTrackedBrowser(trackedBrowser) : null;
}

if (!failure && cleanup?.remaining?.length) {
  failure = new Error(`Nie posprzątano własnego drzewa Chromium: ${json(cleanup.remaining)}`);
}

if (failure) {
  console.error(`FAIL ui-v0517-smoke: ${failure.stack ?? failure.message}`);
  console.error(`CONSOLE_ERRORS ${json(consoleErrors)}`);
  process.exitCode = 1;
} else {
  console.log(json({
    result: "PASS",
    checks: checks.length,
    consoleErrors,
    browserCleanup: {
      rootPid: cleanup?.rootPid ?? null,
      remainingProcesses: cleanup?.remaining?.length ?? 0,
    },
  }));
}
