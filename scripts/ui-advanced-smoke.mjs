import { readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import path from "node:path";
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from "./browser-lifecycle.mjs";

const APP_URL = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4173/";
const EDGE_PATH = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SAVE_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1";
const SAVE_BACKUP_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1-backup";
const INSTANCE_ID = "BM-01";
const RULESET_VERSION = "rotw-hex-combat-v0.5.0-preparation-adaptation";
const STEP_TIMEOUT_MS = 15_000;
const EDGE_STARTUP_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 150_000;

let emergencyBrowser = null;
let emergencyCdp = null;
installGlobalCleanupHandlers();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fatal(message, detail) {
  const suffix = detail === undefined ? "" : `\n  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  throw new Error(`${message}${suffix}`);
}

async function waitFor(predicate, description, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  fatal(`Timeout: ${description}`, lastError?.message);
}

async function requestText(url, timeoutMs = 1_500) {
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
    fatal(`Aplikacja nie odpowiada pod ${APP_URL}. Uruchom najpierw serwer.`, error.message);
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
        for (const { reject, timeout } of this.pending.values()) {
          clearTimeout(timeout);
          reject(error);
        }
        this.pending.clear();
      });
    });
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
  return launchTrackedBrowser({ edgePath: EDGE_PATH, windowSize: "1536,1024", appUrl: "about:blank", startupTimeoutMs: EDGE_STARTUP_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
}

function savedUnit(snapshot, id) {
  return snapshot.combat.units.find((unit) => unit.id === id);
}

function savedMap(entries) {
  return new Map(entries ?? []);
}

function stableProjection(snapshot) {
  return {
    partyIds: snapshot.partyIds,
    phase: snapshot.battlePreparation?.phase,
    activation: snapshot.battlePreparation?.activation,
    actionSequence: snapshot.battlePreparation?.actionSequence,
    scheduler: snapshot.combat?.scheduler,
    readiness: snapshot.combat?.readiness,
    units: snapshot.combat?.units,
    hexGrid: snapshot.hexGrid,
    locations: snapshot.portals?.locations,
    portals: snapshot.portals?.portals,
    pendingReturns: snapshot.pendingReturns,
    scrolls: snapshot.portalScrolls,
    enemyAi: snapshot.enemyAi,
    loot: snapshot.loot,
  };
}

async function run() {
  await requireServer();
  let edge;
  let cdp;
  const passed = [];
  const failed = [];
  const runtimeErrors = [];
  const httpErrors = [];

  const check = (condition, message, detail) => {
    if (condition) {
      passed.push(message);
      process.stdout.write(`  ✓ ${message}\n`);
    } else {
      failed.push({ message, detail });
      process.stdout.write(`  ✗ ${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
    }
    return Boolean(condition);
  };
  const equal = (actual, expected, message) => check(Object.is(actual, expected), message, { expected, actual });

  try {
    process.stdout.write(`Zaawansowany smoke UI v0.5: ${APP_URL}\n`);
    edge = await launchHeadlessEdge();
    emergencyBrowser = edge;
    process.stdout.write(`  · Edge headless PID ${edge.child.pid}, izolowany CDP ${edge.port}\n`);
    cdp = new CdpClient(edge.target.webSocketDebuggerUrl);
    emergencyCdp = cdp;
    await cdp.connect();

    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      runtimeErrors.push(`uncaught: ${exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? "nieznany wyjątek"}`);
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
        userGesture: true,
      });
      if (result.exceptionDetails) {
        fatal("Runtime.evaluate zgłosił wyjątek", result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result?.value;
    };
    const query = (expression) => evaluate(`(() => (${expression}))()`);
    const uiState = () => query(`({
      ready: document.readyState,
      heroes: document.querySelectorAll("#party .hero").length,
      acting: document.querySelector("#acting-name")?.textContent?.trim(),
      inspected: document.querySelector("#inspected-name-side")?.textContent?.trim(),
      sim: document.querySelector("#sim-time")?.textContent?.trim(),
      phase: document.body.dataset.battlePhase,
      enemiesEnabled: document.body.dataset.enemyTurnsEnabled,
      panelHidden: document.querySelector("#panel-layer")?.classList.contains("hidden"),
      panelClass: document.querySelector("#panel-body")?.className,
      targetingHidden: document.querySelector("#targeting-banner")?.classList.contains("hidden"),
      targetingText: document.querySelector("#targeting-copy")?.textContent?.trim(),
      toast: document.querySelector("#game-toast")?.textContent?.trim()
    })`);

    const centerOf = (selector) => query(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()`);
    const clickPoint = async (x, y) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      await delay(100);
    };
    const click = async (selector) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center", inline: "center" })`);
      await delay(40);
      const point = await centerOf(selector);
      if (!point || point.width <= 0 || point.height <= 0) fatal(`Nie można kliknąć ${selector}`, point);
      await clickPoint(point.x, point.y);
    };
    const activateHiddenCommand = async (selector) => {
      const activated = await query(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.click();
        return true;
      })()`);
      if (!activated) fatal(`Brak ukrytego polecenia ${selector}`);
      await delay(100);
    };
    const hasVisible = (selector) => query(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return !node.disabled && !node.classList.contains("hidden") && rect.width > 0 && rect.height > 0;
    })()`);
    const press = async (code) => {
      const definitions = {
        KeyP: { key: "p", virtualKeyCode: 80 },
        Escape: { key: "Escape", virtualKeyCode: 27 },
      };
      const definition = definitions[code];
      if (!definition) fatal(`Brak definicji klawisza ${code}`);
      await cdp.send("Page.bringToFront");
      await evaluate("window.focus()");
      const params = {
        code,
        key: definition.key,
        windowsVirtualKeyCode: definition.virtualKeyCode,
        nativeVirtualKeyCode: definition.virtualKeyCode,
        autoRepeat: false,
        isKeypad: false,
      };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
      await delay(100);
    };
    const canvasPoint = async (q, r) => {
      await evaluate(`document.querySelector("#scene")?.scrollIntoView({ block: "center", inline: "center" })`);
      await delay(50);
      return query(`(() => {
        const rect = document.querySelector("#scene").getBoundingClientRect();
        const local = window.__rotwDebug?.projectHex?.(${q}, ${r});
        if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.y)) return null;
        return {
          x: rect.left + local.x,
          y: rect.top + local.y
        };
      })()`);
    };
    const save = async () => {
      if (!(await uiState()).panelHidden) await press("Escape");
      await click("#save");
      const snapshot = await query(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);
      if (!snapshot) fatal("Przycisk zapisu nie utworzył snapshotu v3");
      return snapshot;
    };
    const loadThroughOptions = async () => {
      if (!(await uiState()).panelHidden) await press("Escape");
      await activateHiddenCommand('[data-open-panel="options"]');
      await click("#load-save");
      await delay(150);
    };

    await cdp.send("Page.navigate", { url: APP_URL });
    await waitFor(async () => {
      const state = await uiState();
      return state.ready === "complete" && state.heroes === 3 && state.acting === "Korgan" && state.phase === "preparation" ? state : false;
    }, "pełny start scenariusza v0.5");

    process.stdout.write("\n[1. Przygotowanie i wspólna kolejka aktywnej walki]\n");
    const dormant = await query(`globalThis.__rotwDebug.snapshot()`);
    equal(dormant.phase, "preparation", "scenariusz zaczyna się w fazie przygotowania");
    equal(dormant.enemyTurnsEnabled, false, "scheduler nie oddaje tur wrogom przed aktywacją");
    equal(dormant.actingUnitId, "korgan", "Korgan jest wybranym bohaterem przygotowania");
    equal(dormant.save.combat.readiness.currentActorId, null, "model walki nie ma otwartego okna tury w preparation");
    await press("KeyP");
    const preparationPortalAttempt = await uiState();
    check(preparationPortalAttempt.targetingHidden && /PO ROZPOCZĘCIU WALKI/i.test(preparationPortalAttempt.toast), "portal w przygotowaniu jest jawnie niedostępny zamiast otwierać martwe celowanie", preparationPortalAttempt);
    await activateHiddenCommand("#portal-quick");
    check(!(await hasVisible("#replace-own-portal")), "panel portalu nie pokazuje obejścia otwarcia portalu podczas przygotowania");
    await press("Escape");

    await click("#start-battle");
    const opening = await waitFor(async () => {
      const state = await uiState();
      return state.phase === "active" && state.acting === "Korgan" ? state : false;
    }, "jawne uruchomienie aktywnej kolejki");
    equal(opening.enemiesEnabled, "true", "jawny start aktywuje wrogów");
    const openingSave = await save();
    equal(openingSave.game_ruleset_version, RULESET_VERSION, "kolejka działa pod rulesetem v0.5");
    equal(openingSave.partyIds.join(","), "korgan,hadriel,ormus", "w kolejce uczestniczy właściwa trójka bohaterów");
    equal(openingSave.battlePreparation.phase, "active", "zapis oznacza aktywną fazę walki");
    equal(openingSave.combat.readiness.currentActorId, "korgan", "autorytatywne pierwsze okno należy do Korgana");
    check(openingSave.combat.scheduler.queue.filter(({ kind }) => kind === "actor:ready").length >= 3, "gotowości bohaterów i wroga są zdarzeniami wspólnego schedulera", openingSave.combat.scheduler.queue);

    await click("#end-turn");
    equal((await uiState()).acting, "Hadriel", "po Korganie kolej otrzymuje Hadriel");
    await click("#end-turn");
    equal((await uiState()).acting, "Ormus", "po Hadrielu kolej otrzymuje Ormus");
    await click("#end-turn");
    const afterCycleState = await waitFor(async () => {
      const state = await uiState();
      return state.acting === "Korgan" ? state : false;
    }, "automatyczne rozliczenie tury przeciwnika i powrót Korgana");
    check(afterCycleState.sim !== opening.sim, "pełny cykl przesuwa autorytatywny zegar walki", { before: opening.sim, after: afterCycleState.sim });
    const queueSave = await save();
    equal(queueSave.combat.readiness.timelineMode, "recovery", "zapis zachowuje model wspólnej kolejki recovery-time");
    check(queueSave.combat.scheduler.time > openingSave.combat.scheduler.time, "scheduler przeszedł do kolejnego okna gotowości", { before: openingSave.combat.scheduler.time, after: queueSave.combat.scheduler.time });
    check(queueSave.combat.scheduler.queue.some(({ kind }) => kind === "move:step"), "ruch AI pozostaje w tej samej kolejce zdarzeń", queueSave.combat.scheduler.queue);
    check((queueSave.hexGrid.reservations ?? []).length > 0, "zapis obejmuje rezerwacje przyszłych kroków ruchu", queueSave.hexGrid.reservations);
    for (const id of ["korgan", "hadriel", "ormus", "fallen-1"]) {
      check(Number.isFinite(savedUnit(queueSave, id)?.readyAt), `${id}: zapis ma wyznaczony czas gotowości`);
    }

    process.stdout.write("\n[2. Wznowienie zapisu z przyszłym ruchem AI]\n");
    const queueProjection = JSON.stringify(stableProjection(queueSave));
    await click("#end-turn");
    check((await uiState()).acting !== "Korgan", "akcja po zapisie realnie zmienia otwarte okno");
    await loadThroughOptions();
    const resumedState = await uiState();
    equal(resumedState.acting, "Korgan", "wczytanie przywraca właściciela kolejki");
    equal(resumedState.phase, "active", "wczytanie nie cofa aktywnej walki do przygotowania");
    const resumedSave = await query(`globalThis.__rotwDebug.snapshot().save`);
    equal(JSON.stringify(stableProjection(resumedSave)), queueProjection, "wczytanie przywraca scheduler, rezerwacje i stan jednostek bez dryfu");

    process.stdout.write("\n[3. Miejski Portal i grupowy odwrót trzech bohaterów]\n");
    const enemyHpBeforePortal = savedUnit(resumedSave, "fallen-1").hp;
    await press("KeyP");
    let portalState = await uiState();
    check(!portalState.targetingHidden && portalState.targetingText.toUpperCase().includes("FIOLETOWE"), "P uruchamia prawdziwy wybór heksa portalu");
    const point = await canvasPoint(2, 3);
    await clickPoint(point.x, point.y);
    await waitFor(async () => (await uiState()).targetingHidden, "zatwierdzenie heksa portalu");
    const opened = await save();
    const korganSupply = savedMap(opened.portalScrolls).get("korgan");
    equal(korganSupply.tomeScrolls, 2, "legalne otwarcie portalu zużywa dokładnie jeden zwój Korgana");
    const activePortal = opened.portals.portals.find((portal) => portal.owner_character_id === "korgan" && portal.active);
    check(Boolean(activePortal), "zapis zawiera aktywny portal Korgana");
    equal(activePortal?.source.instance_id, INSTANCE_ID, "portal pamięta źródłową instancję BM-01");

    await activateHiddenCommand("#portal-quick");
    const partyButtonVisible = await hasVisible("#party-to-portal");
    check(partyButtonVisible, "panel portalu udostępnia rozkaz dla całej trójki");
    if (!partyButtonVisible) fatal("Brak przycisku grupowego wejścia do portalu");
    await click("#party-to-portal");
    const groupSave = await save();
    const locations = savedMap(groupSave.portals.locations);
    for (const id of ["korgan", "hadriel", "ormus"]) {
      equal(locations.get(id)?.kind, "town", `${id} dociera do miasta przez portal`);
    }
    const enteredTown = groupSave.portals.transitionLog
      .filter((entry) => entry.kind === "entered_town" && entry.portal_id === activePortal?.portal_id)
      .map((entry) => entry.character_id);
    equal(enteredTown.length, 3, "grupowy odwrót wykonuje trzy osobne przejścia");
    equal(enteredTown.at(-1), "korgan", "właściciel Korgan przechodzi jako ostatni");
    equal(savedUnit(groupSave, "fallen-1").hp, enemyHpBeforePortal, "odwrót nie zadaje wrogowi ukrytych obrażeń");
    equal(savedUnit(groupSave, "fallen-1").rewardsGranted, false, "żywy wróg nie przyznaje nagrody ani zwycięstwa");
    check(groupSave.roster.every((character) => character.experience === 0), "portal daje EXP +0");
    equal(groupSave.portals.portals.find((portal) => portal.portal_id === activePortal?.portal_id)?.status, "active", "portal pozostaje aktywną drogą powrotu po odwrocie");
    equal(groupSave.loot, null, "grupowy odwrót nie tworzy łupu");

    process.stdout.write("\n[4. Migracja presence schema 1 i grupowy powrót]\n");
    await evaluate(`(() => {
      const legacy = ${JSON.stringify(groupSave)};
      const preparation = legacy.battlePreparation;
      preparation.schemaVersion = 1;
      delete preparation.heroPresence;
      legacy.partyIds.forEach((heroId, index) => {
        if (!preparation.positions.some(({ unitId }) => unitId === heroId)) {
          // Schema 1 always carried a position even for an off-field hero. The
          // coordinates are deliberately unique legacy ghosts; schema 2 must
          // infer town presence from the authoritative portal locations.
          preparation.positions.push({ unitId: heroId, q: index, r: 7 });
        }
      });
      preparation.positions.sort((left, right) => left.unitId.localeCompare(right.unitId, "en"));
      localStorage.setItem(${JSON.stringify(SAVE_KEY)}, JSON.stringify(legacy));
      localStorage.removeItem(${JSON.stringify(SAVE_BACKUP_KEY)});
    })()`);
    await loadThroughOptions();
    const migratedTownSave = await query(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);
    if (migratedTownSave?.battlePreparation?.schemaVersion !== 2) {
      fatal("Migracja presence schema 1 nie została opublikowana", await uiState());
    }
    equal(migratedTownSave.battlePreparation.schemaVersion, 2, "legacy presence schema 1 jest po wczytaniu publikowany jako schema 2");
    for (const id of ["korgan", "hadriel", "ormus"]) {
      equal(migratedTownSave.battlePreparation.heroPresence.find(({ heroId }) => heroId === id)?.state, "off-field", `${id}: migracja wyprowadza bohatera miejskiego z pola`);
      equal(migratedTownSave.battlePreparation.positions.some(({ unitId }) => unitId === id), false, `${id}: migracja usuwa dawną ghost position`);
    }

    await activateHiddenCommand("#portal-quick");
    const partyReturnVisible = await hasVisible("#party-return-through-portal");
    check(partyReturnVisible, "panel portalu pozwala całej trójce wrócić do tej samej instancji");
    if (!partyReturnVisible) fatal("Brak przycisku grupowego powrotu przez portal");
    await click("#party-return-through-portal");
    const returnedSave = await save();
    const returnedLocations = savedMap(returnedSave.portals.locations);
    equal(returnedSave.pendingReturns.length, 0, "grupowy powrót opróżnia kolejkę zaplanowanych przejść");
    for (const id of ["korgan", "hadriel", "ormus"]) {
      equal(returnedLocations.get(id)?.kind, "area", `${id}: powrót odtwarza lokację obszaru`);
      equal(returnedSave.battlePreparation.heroPresence.find(({ heroId }) => heroId === id)?.state, "on-field", `${id}: powrót odtwarza obecność na polu`);
      const preparationPosition = returnedSave.battlePreparation.positions.find(({ unitId }) => unitId === id);
      const gridPosition = returnedSave.hexUnits.find(({ id: unitId }) => unitId === id)?.position;
      check(preparationPosition?.q === gridPosition?.q && preparationPosition?.r === gridPosition?.r, `${id}: zapis po powrocie ma jedną zgodną pozycję w modelach`, { preparationPosition, gridPosition });
    }

    process.stdout.write("\n[5. Kopia zapasowa i transakcyjne odrzucenie uszkodzonego zapisu]\n");
    const valid = await save();
    const validProjection = JSON.stringify(stableProjection(valid));
    await evaluate(`(() => {
      const encoded = localStorage.getItem(${JSON.stringify(SAVE_KEY)});
      localStorage.setItem(${JSON.stringify(SAVE_BACKUP_KEY)}, encoded);
      const broken = JSON.parse(encoded);
      broken.battlePreparation.phase = "broken-phase";
      localStorage.setItem(${JSON.stringify(SAVE_KEY)}, JSON.stringify(broken));
    })()`);
    await loadThroughOptions();
    const recovered = await query(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);
    equal(recovered.schemaVersion, 3, "uszkodzony zapis główny jest odzyskiwany z kopii v3");
    equal(recovered.game_ruleset_version, RULESET_VERSION, "odzyskana kopia zachowuje ruleset v0.5");
    equal(JSON.stringify(stableProjection(recovered)), validProjection, "odzyskanie kopii nie zmienia świata, kolejki ani portalu");

    const beforeRejected = await query(`globalThis.__rotwDebug.snapshot().save`);
    const beforeRejectedProjection = JSON.stringify(stableProjection(beforeRejected));
    await evaluate(`(() => {
      localStorage.setItem(${JSON.stringify(SAVE_KEY)}, JSON.stringify({ schemaVersion: 99, marker: "broken-main" }));
      localStorage.setItem(${JSON.stringify(SAVE_BACKUP_KEY)}, JSON.stringify({ schemaVersion: 99, marker: "broken-backup" }));
    })()`);
    await loadThroughOptions();
    portalState = await uiState();
    check(portalState.toast.includes("Nie udało się wczytać"), "interfejs pokazuje czytelny błąd dwóch uszkodzonych kopii", portalState.toast);
    const afterRejected = await query(`globalThis.__rotwDebug.snapshot().save`);
    equal(JSON.stringify(stableProjection(afterRejected)), beforeRejectedProjection, "odrzucone kopie nie mutują bieżącej sesji");
    if (!portalState.panelHidden) await press("Escape");

    check(runtimeErrors.length === 0, "zaawansowany test kończy się bez nieobsłużonych błędów JavaScript", runtimeErrors);
    check(httpErrors.length === 0, "zaawansowany test kończy się bez odpowiedzi HTTP 4xx/5xx", httpErrors);
    if (failed.length) fatal(`${failed.length} z ${passed.length + failed.length} asercji nie przeszło`, failed);
    process.stdout.write(`\nPASS ADVANCED: ${passed.length} asercji, Edge headless, bez widocznego okna.\n`);
  } finally {
    cdp?.close();
    await cleanupTrackedBrowser(edge);
    emergencyBrowser = null;
    emergencyCdp = null;
  }
}

const hardTimeout = setTimeout(async () => {
  process.stderr.write(`FAIL ADVANCED UI: twardy timeout ${HARD_TIMEOUT_MS} ms\n`);
  emergencyCdp?.close();
  await cleanupTrackedBrowser(emergencyBrowser).catch(() => {});
  process.exit(1);
}, HARD_TIMEOUT_MS);

run().then(() => {
  clearTimeout(hardTimeout);
}).catch((error) => {
  clearTimeout(hardTimeout);
  process.stderr.write(`FAIL ADVANCED UI: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
