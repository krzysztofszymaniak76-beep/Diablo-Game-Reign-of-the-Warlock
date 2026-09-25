import { readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import path from "node:path";
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from "./browser-lifecycle.mjs";

const APP_URL = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4173/?training=1";
const EDGE_PATH = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SAVE_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1";
const SAVE_BACKUP_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1-backup";
const LEGACY_SAVE_KEY = "rotw-prototype-save-v2";
const STEP_TIMEOUT_MS = 15_000;
const EDGE_STARTUP_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 120_000;

const EXPECTED_LOADOUTS = Object.freeze({
  korgan: Object.freeze([
    "barbarian.bash",
    "barbarian.battle_orders",
    "barbarian.shout",
    "barbarian.whirlwind",
  ]),
  hadriel: Object.freeze([
    "paladin.zeal",
    "paladin.might",
    "paladin.holy_fire",
    "paladin.blessed_hammer",
  ]),
  ormus: Object.freeze([
    "necromancer.teeth",
    "necromancer.raise_skeleton",
    "necromancer.clay_golem",
    "necromancer.amplify_damage",
  ]),
});

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

function assert(condition, message, detail) {
  if (!condition) fail(message, detail);
}

function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) fail(message, { expected, actual });
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
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
        } else {
          resolve(body);
        }
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
    fail(`Aplikacja nie odpowiada pod ${APP_URL}. Uruchom serwer na osobnym porcie przed testem.`, error.message);
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

function canonicalJson(value) {
  return JSON.stringify(value);
}

function withEnemyAt(snapshot, q, r) {
  const positioned = structuredClone(snapshot);
  const registries = [positioned.hexUnits, positioned.hexGrid?.units, positioned.combat?.units];
  for (const registry of registries) {
    if (!Array.isArray(registry)) fail("Scenariusz testowy nie może znaleźć rejestru pozycji przeciwnika", positioned);
    const enemy = registry.find(({ id }) => id === "fallen-1");
    if (!enemy) fail("Scenariusz testowy nie może znaleźć przeciwnika fallen-1", registry);
    enemy.position = { q, r };
  }
  return positioned;
}

async function run() {
  await requireServer();
  const assertions = [];
  const runtimeErrors = [];
  const httpErrors = [];
  let edge;
  let cdp;

  const check = (condition, message, detail) => {
    assert(condition, message, detail);
    assertions.push(message);
    process.stdout.write(`  ✓ ${message}\n`);
  };
  const equal = (actual, expected, message) => {
    assertEqual(actual, expected, message);
    assertions.push(message);
    process.stdout.write(`  ✓ ${message}\n`);
  };

  try {
    process.stdout.write(`Smoke UI v0.5: ${APP_URL}\n`);
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
        userGesture: true,
      });
      if (result.exceptionDetails) {
        fail("Runtime.evaluate zgłosił wyjątek", result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result?.value;
    };
    const query = (expression) => evaluate(`(() => (${expression}))()`);
    const click = async (selector) => {
      const outcome = await query(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return { ok: false, reason: "missing" };
        if (element.disabled) return { ok: false, reason: "disabled" };
        element.click();
        return { ok: true };
      })()`);
      assert(outcome?.ok, `Nie można kliknąć ${selector}`, outcome);
      await delay(100);
    };
    const clickCanvasHex = async (q, r) => {
      const outcome = await query(`(() => {
        const canvas = document.querySelector("#scene");
        if (!canvas) return { ok: false, reason: "missing-canvas" };
        const rect = canvas.getBoundingClientRect();
        const local = window.__rotwDebug?.projectHex?.(${q}, ${r});
        const viewport = window.__rotwDebug?.battlefieldGeometry?.()?.viewport;
        if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.y)) {
          return { ok: false, reason: "missing-projectHex", local };
        }
        const clientX = rect.left + local.x * rect.width / viewport.width;
        const clientY = rect.top + local.y * rect.height / viewport.height;
        canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));
        canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX, clientY }));
        return { ok: true, clientX, clientY, width: rect.width, height: rect.height };
      })()`);
      assert(outcome?.ok, `Nie można kliknąć heksa (${q},${r})`, outcome);
      await delay(150);
    };
    const storePrimarySave = async (snapshot, { removeFallbacks = false } = {}) => {
      const encoded = JSON.stringify(snapshot);
      await evaluate(`(() => {
        localStorage.setItem(${JSON.stringify(SAVE_KEY)}, ${JSON.stringify(encoded)});
        ${removeFallbacks ? `localStorage.removeItem(${JSON.stringify(SAVE_BACKUP_KEY)}); localStorage.removeItem(${JSON.stringify(LEGACY_SAVE_KEY)});` : ""}
        return true;
      })()`);
    };
    const loadThroughOptions = async () => {
      const panelOpen = await query('!document.querySelector("#panel-layer")?.classList.contains("hidden")');
      if (panelOpen) await click("#close-panel");
      await click('[data-open-panel="options"]');
      await waitFor(() => query('Boolean(document.querySelector("#load-save"))'), "przycisk WCZYTAJ ZAPIS");
      await click("#load-save");
      await delay(150);
    };
    const debugSnapshot = async () => {
      const result = await query(`(() => {
        if (typeof window.__rotwDebug?.snapshot !== "function") {
          return { __missingDebug: true, keys: Object.keys(window.__rotwDebug ?? {}) };
        }
        return window.__rotwDebug.snapshot();
      })()`);
      assert(!result?.__missingDebug,
        "Runtime nie wystawia wymaganego window.__rotwDebug.snapshot(); test nie zastępuje danych autorytatywnych domysłami",
        result);
      return result;
    };
    const uiSnapshot = () => query(`({
      ready: document.readyState,
      partySize: document.querySelector("#party-size")?.textContent?.trim(),
      heroIds: [...document.querySelectorAll("#party .hero")].map((node) => node.dataset.characterId),
      inspected: document.querySelector("#inspected-name-side")?.textContent?.trim(),
      sim: document.querySelector("#sim-time")?.textContent?.trim(),
      phase: document.querySelector(".battle-state")?.dataset.battlePhase,
      phaseLabel: document.querySelector("#phase-label")?.textContent?.trim(),
      phaseDetail: document.querySelector("#phase-detail")?.textContent?.trim(),
      queueState: document.querySelector("#queue-state")?.textContent?.trim(),
      queueTokens: document.querySelectorAll("#initiative-row .initiative-token").length,
      startBattleVisible: (() => {
        const node = document.querySelector("#start-battle");
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return !node.disabled && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })(),
      cards: [...document.querySelectorAll("#cards .skill-card")].map((node) => ({
        id: node.id,
        role: node.dataset.slotRole,
        rightIndex: node.dataset.rightIndex ?? null,
        skillId: node.dataset.skillId,
        category: node.dataset.category,
        name: node.querySelector(".card-name")?.textContent?.trim(),
        disabled: node.disabled,
      })),
    })`);

    await cdp.send("Page.navigate", { url: APP_URL });
    const initial = await waitFor(async () => {
      const ui = await uiSnapshot();
      if (ui.ready !== "complete" || ui.heroIds.length !== 3 || ui.cards.length !== 4) return false;
      if (ui.cards.some((card) => !card.skillId || !card.category)) return false;
      const debug = await debugSnapshot();
      return debug?.phase ? { ui, debug } : false;
    }, "stabilny start UI v0.5 i kontrakt debug");

    equal(initial.ui.heroIds.length, 3, "pole walki renderuje dokładnie 3 główne portrety");
    equal(new Set(initial.ui.heroIds).size, 3, "każdy portret drużyny ma unikalną tożsamość");
    check(/^3\s*\/\s*3$/.test(initial.ui.partySize), "licznik UI potwierdza limit trzyosobowej drużyny", initial.ui.partySize);
    equal(initial.debug.preparation?.heroIds?.length, 3, "autorytatywne przygotowanie obejmuje dokładnie 3 bohaterów");

    equal(initial.ui.phase, "preparation", "DOM rozpoczyna w fazie preparation");
    equal(initial.debug.phase, "preparation", "runtime rozpoczyna w fazie preparation");
    equal(initial.debug.enemyTurnsEnabled, false, "tury AI są wyłączone podczas przygotowania");
    equal(initial.debug.enemyAwarenessEnabled, false, "świadomość AI jest wyłączona podczas przygotowania");
    check(/AI\s+UŚPIONE/i.test(initial.ui.queueState), "HUD jawnie pokazuje uśpione AI", initial.ui.queueState);
    equal(initial.ui.startBattleVisible, true, "jawny przycisk rozpoczęcia starcia jest widoczny i dostępny");
    equal(initial.ui.cards.length, 4, "panel umiejętności zawiera dokładnie cztery karty");
    check(!/ATAK\s+PODSTAWOWY/i.test(await query('document.querySelector("#cards")?.textContent')), "cały panel kart nie zawiera generycznego „ATAK PODSTAWOWY”");

    const deployment = await query(`(() => {
      const scene = document.querySelector("#scene");
      const legend = document.querySelector("[data-deployment-zone]");
      return {
        columns: Number(scene?.dataset.deploymentColumns),
        cells: Number(scene?.dataset.deploymentCells),
        legend: legend?.textContent?.replace(/\\s+/g, " ")?.trim(),
      };
    })()`);
    equal(deployment.columns, 3, "canvas deklaruje dokładnie 3 kolumny rozstawienia");
    equal(initial.debug.preparation?.rules?.deploymentColumns, 3, "runtime potwierdza dokładnie 3 kolumny rozstawienia");
    check(deployment.cells === 26 && /3\s+(ZIELONE\s+)?KOLUMNY/i.test(deployment.legend), "strefa rozstawienia ma 26 pól i czytelną legendę", deployment);
    check((initial.debug.preparation?.positions ?? []).every(({ q, r }) => {
      const column = q;
      return column >= 0 && column < 3;
    }), "wszyscy bohaterowie przygotowania zaczynają w trzech zielonych kolumnach", initial.debug.preparation?.positions);
    equal(initial.debug.save?.hexGrid?.tiles?.length, 213, "autorytatywna plansza zawiera 213 pełnych pól heksowych");
    equal(new Set((initial.debug.save?.hexGrid?.tiles ?? []).map(({ q, r }) => `${q},${r}`)).size, 213, "każdy z 213 heksów ma unikalne współrzędne");

    const startEnemy = initial.debug.save?.combat?.units?.find(({ id }) => id === "fallen-1");
    check(startEnemy && Number.isFinite(startEnemy.hp), "debug snapshot zawiera autorytatywny stan przeciwnika", startEnemy);
    const startSim = initial.ui.sim;
    await delay(300);
    const idleUi = await uiSnapshot();
    const idleDebug = await debugSnapshot();
    equal(idleUi.sim, startSim, "bezczynne przygotowanie nie przesuwa zegara symulacji");
    equal(idleDebug.save?.combat?.scheduler?.time, initial.debug.save?.combat?.scheduler?.time, "bezczynne przygotowanie nie przesuwa autorytatywnego zegara");
    equal(canonicalJson(idleDebug.hexUnits?.find(({ id }) => id === "fallen-1")), canonicalJson(initial.debug.hexUnits?.find(({ id }) => id === "fallen-1")), "uśpiony przeciwnik nie zmienia pozycji");
    equal(idleDebug.save?.combat?.units?.find(({ id }) => id === "fallen-1")?.hp, startEnemy?.hp, "uśpiony przeciwnik nie wykonuje ataku");

    const signatures = new Set();
    for (const [heroId, expectedSkillIds] of Object.entries(EXPECTED_LOADOUTS)) {
      await click(`[data-character-id="${heroId}"]`);
      const ui = await uiSnapshot();
      const debug = await debugSnapshot();
      const actualSkillIds = ui.cards.map(({ skillId }) => skillId);
      equal(canonicalJson(actualSkillIds), canonicalJson(expectedSkillIds), `kliknięcie portretu ${heroId} pokazuje jego własne cztery karty`);
      equal(ui.cards.filter(({ role }) => role === "left").length, 1, `${heroId} ma dokładnie 1 kartę lewego slotu`);
      equal(ui.cards.filter(({ role }) => role === "right").length, 3, `${heroId} ma dokładnie 3 karty prawego slotu`);
      equal(ui.cards.filter(({ rightIndex }) => rightIndex !== null).map(({ rightIndex }) => rightIndex).join(","), "0,1,2", `${heroId} ma stabilną kolejność trzech prawych slotów`);
      check(ui.cards.every(({ name }) => name && !/ATAK\s+PODSTAWOWY/i.test(name)), `${heroId} nie używa karty „ATAK PODSTAWOWY”`, ui.cards);
      equal(debug.actingUnitId, heroId, `w przygotowaniu portret ${heroId} wybiera bohatera wydającego rozkazy`);
      signatures.add(actualSkillIds.join("|"));
    }
    equal(signatures.size, 3, "każdy z trzech portretów rzeczywiście zmienia zestaw kart");

    await click('[data-character-id="korgan"]');
    const beforeFormationMove = await debugSnapshot();
    await click("#move-command");
    await clickCanvasHex(0, 3);
    const afterFormationMove = await debugSnapshot();
    equal(afterFormationMove.phase, "preparation", "ruch wewnątrz zielonej strefy pozostawia fazę preparation");
    equal(afterFormationMove.save?.combat?.scheduler?.time, beforeFormationMove.save?.combat?.scheduler?.time, "ruch formacyjny w zielonej strefie jest bezkosztowy");
    equal(canonicalJson(afterFormationMove.preparation?.positions?.find(({ unitId }) => unitId === "korgan")), canonicalJson({ unitId: "korgan", q: 0, r: 3 }), "kliknięcie pełnego heksa rzeczywiście przestawia Barbarzyńcę w obrębie strefy");
    equal(afterFormationMove.enemyTurnsEnabled, false, "ruch formacyjny nie budzi AI");

    const prepLoadoutBefore = afterFormationMove.preparation.loadouts.find(({ heroId }) => heroId === "korgan");
    const prepLoadoutTime = afterFormationMove.save.combat.scheduler.time;
    await click("#change-loadout");
    let loadoutChanged = await debugSnapshot();
    const prepLoadoutAfter = loadoutChanged.preparation.loadouts.find(({ heroId }) => heroId === "korgan");
    check(canonicalJson(prepLoadoutAfter) !== canonicalJson(prepLoadoutBefore), "ZMIEŃ SKILL modyfikuje loadout Barbarzyńcy w przygotowaniu", { prepLoadoutBefore, prepLoadoutAfter });
    equal(prepLoadoutAfter.right.length, 3, "zmiana skilla zachowuje kontrakt trzech prawych slotów");
    equal(loadoutChanged.save.combat.scheduler.time, prepLoadoutTime, "zmiana loadoutu w preparation nie przesuwa zegara");
    equal(loadoutChanged.phase, "preparation", "zmiana loadoutu w preparation nie aktywuje walki");
    await click("#change-loadout");
    loadoutChanged = await debugSnapshot();
    equal(canonicalJson(loadoutChanged.preparation.loadouts.find(({ heroId }) => heroId === "korgan")), canonicalJson(prepLoadoutBefore), "drugie kliknięcie przywraca bazowy loadout przed dalszym testem");

    equal(await query('document.querySelector("#hud-belt-slot-1")?.dataset.filled'), 'false', "nowa postać rozpoczyna z pustym pasem");
    const potionTimeBefore = (await debugSnapshot()).save.combat.scheduler.time;
    check(await query('document.querySelector("#hud-belt-slot-1")?.disabled'), "pustego miejsca pasa nie można użyć");
    equal((await debugSnapshot()).save.combat.scheduler.time, potionTimeBefore, "pusty pas nie przesuwa zegara ani nie budzi AI");

    await click('[data-character-id="ormus"]');
    await click('#cards [data-skill-id="necromancer.teeth"]');
    const rangeAlert = await query(`(() => {
      const banner = document.querySelector("#targeting-banner[role=alert]");
      const copy = document.querySelector("#targeting-copy");
      if (!banner || !copy) return null;
      const bannerStyle = getComputedStyle(banner);
      const copyStyle = getComputedStyle(copy);
      return {
        visible: !banner.classList.contains("hidden") && bannerStyle.display !== "none" && bannerStyle.visibility !== "hidden",
        text: copy.textContent?.replace(/\\s+/g, " ")?.trim(),
        fontSize: Number.parseFloat(copyStyle.fontSize),
      };
    })()`);
    check(rangeAlert?.visible && /ZASIĘG/i.test(rangeAlert.text), "karta dystansowa pokazuje jawny alert zasięgu", rangeAlert);
    check(rangeAlert.fontSize >= 14, "tekst alertu zasięgu ma co najmniej 14 px", rangeAlert);
    const distantEnemyHex = (await debugSnapshot()).hexUnits.find(({ id }) => id === "fallen-1")?.position;
    check(Number.isInteger(distantEnemyHex?.q) && Number.isInteger(distantEnemyHex?.r),
      "odległy przeciwnik ma legalną pozycję na bieżącej planszy", distantEnemyHex);
    await clickCanvasHex(distantEnemyHex.q, distantEnemyHex.r);
    const outOfRange = await query(`(() => ({
      title: document.querySelector("#targeting-title")?.textContent?.trim(),
      copy: document.querySelector("#targeting-copy")?.textContent?.replace(/\\s+/g, " ")?.trim(),
      toast: document.querySelector("#game-toast")?.textContent?.replace(/\\s+/g, " ")?.trim(),
      fontSize: Number.parseFloat(getComputedStyle(document.querySelector("#targeting-copy")).fontSize),
    }))()`);
    check(/POZA ZASIĘGIEM/i.test(outOfRange.title) && /DYSTANS\s+\d+.*ZASIĘG\s+\d+/i.test(outOfRange.copy), "kliknięcie odległego wroga pokazuje liczbowy błąd zasięgu", outOfRange);
    check(outOfRange.fontSize >= 14, "liczbowy błąd poza zasięgiem pozostaje czytelny (≥14 px)", outOfRange);
    equal((await debugSnapshot()).phase, "preparation", "nielegalny cel poza zasięgiem nie aktywuje walki");
    await click("#cancel-targeting");
    equal((await debugSnapshot()).phase, "preparation", "anulowanie wyboru celu nie rozpoczyna walki");

    const preparationTime = (await debugSnapshot()).save?.combat?.scheduler?.time;
    await click('[data-character-id="korgan"]');
    await click('#cards [data-skill-id="barbarian.battle_orders"]');
    let prepared = await debugSnapshot();
    equal(prepared.phase, "preparation", "Battle Orders nie aktywuje przeciwników podczas przygotowania");
    equal(prepared.save?.combat?.scheduler?.time, preparationTime, "Battle Orders jest bezkosztowe podczas przygotowania");
    check(prepared.preparation?.buffs?.some(({ skillId, remainingTurns }) => skillId === "barbarian.battle_orders" && remainingTurns > 0), "Battle Orders zapisuje buff liczony w turach", prepared.preparation?.buffs);
    check(/AKTYW|TUR/i.test(await query('document.querySelector("[data-warcry-status]")?.textContent')), "HUD pokazuje aktywny okrzyk Barbarzyńcy");

    await click('[data-character-id="hadriel"]');
    await click('#cards [data-skill-id="paladin.might"]');
    prepared = await debugSnapshot();
    equal(prepared.phase, "preparation", "Might nie aktywuje przeciwników podczas przygotowania");
    equal(prepared.save?.combat?.scheduler?.time, preparationTime, "aura Paladyna jest bezkosztowa podczas przygotowania");
    check(prepared.preparation?.buffs?.some(({ skillId, remainingTurns }) => skillId === "paladin.might" && remainingTurns === null), "Might jest utrwalona jako stała aura", prepared.preparation?.buffs);
    check(/MIGHT|AKTYW/i.test(await query('document.querySelector("[data-aura-status]")?.textContent')), "HUD pokazuje aktywną aurę Paladyna");

    await click('[data-character-id="ormus"]');
    const summonCountBefore = prepared.preparation?.summons?.length ?? 0;
    await click('#cards [data-skill-id="necromancer.raise_skeleton"]');
    prepared = await debugSnapshot();
    equal(prepared.phase, "preparation", "Raise Skeleton bez zwłok nie aktywuje przeciwników podczas przygotowania");
    equal(prepared.save?.combat?.scheduler?.time, preparationTime, "odrzucone Raise Skeleton nie przesuwa zegara przygotowania");
    equal(prepared.preparation?.summons?.length, summonCountBefore, "Raise Skeleton bez zwłok nie tworzy nielegalnego summona");
    check(/WYMAGA DOSTĘPNYCH ZWŁOK/i.test(await query('document.querySelector("#game-toast")?.textContent')), "UI jawnie wyjaśnia wymaganie zwłok dla Raise Skeleton");
    equal(Number(await query('document.querySelector("[data-summon-count]")?.dataset.summonCount')), summonCountBefore, "HUD zachowuje prawdziwą liczbę summonów po odrzuceniu");
    equal(prepared.enemyTurnsEnabled, false, "AI pozostaje uśpione po buffie, aurze i odrzuconym summonowaniu");

    const potions = await query(`(() => [1, 2].map((slot) => {
      const element = document.querySelector('#hud-belt-slot-' + slot);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
       return { slot, visible: rect.width > 0 && rect.height > 0, filled: element.dataset.filled };
    }))()`);
    check(potions.every((entry) => entry?.visible && entry.filled === 'false'), "HUD pokazuje puste miejsca pasa", potions);

    await click("#inventory-command");
    const inventory = await waitFor(async () => query(`(() => {
      const panel = document.querySelector("#panel-body.inventory-view");
      if (!panel) return false;
      return {
        cells: panel.querySelectorAll("#inventory-grid .inventory-cell").length,
        activeWeaponTabs: panel.querySelectorAll('.d2-empty-weapon-tabs button[data-weapon-set="1"]:not([disabled])').length,
        inactiveWeaponTabs: panel.querySelectorAll('.d2-empty-weapon-tabs button[data-weapon-set="2"][disabled]').length,
      };
    })()`), "panel ekwipunku v0.5");
    equal(inventory.cells, 40, "ekwipunek renderuje dokładnie 40 pól (10 × 4)");
    equal(inventory.activeWeaponTabs, 2, "oba wzorcowe przełączniki wskazują jedyny aktywny zestaw broni");
    equal(inventory.inactiveWeaponTabs, 2, "drugi zestaw pozostaje nieaktywny zgodnie z mechaniką");
    await click("#close-panel");

    await click("#save");
    const persisted = await query(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);
    check(persisted && typeof persisted === "object", "przycisk ZAPISZ publikuje zapis v3 w localStorage", {
      toast: await query('document.querySelector("#game-toast")?.textContent?.trim()'),
    });
    equal(persisted.partyIds?.length, 3, "zapis utrwala dokładnie trzy partyIds");
    check(persisted.battlePreparation && typeof persisted.battlePreparation === "object", "zapis zawiera jawny snapshot battlePreparation");
    equal(persisted.battlePreparation?.phase, "preparation", "zapis zachowuje fazę preparation");
    equal(persisted.battlePreparation?.loadouts?.length, 3, "zapis zachowuje loadouty wszystkich trzech bohaterów");
    check(persisted.battlePreparation?.loadouts?.every(({ left, right }) => typeof left === "string" && right?.length === 3), "każdy zapisany loadout ma układ 1 lewy + 3 prawe", persisted.battlePreparation?.loadouts);
    equal(persisted.battlePreparation?.summons?.length, prepared.preparation?.summons?.length, "zapis zachowuje summonów przygotowania");
    equal(canonicalJson(persisted.battlePreparation), canonicalJson(prepared.preparation), "zapisany snapshot przygotowania jest zgodny z runtime");
    check(persisted.weaponSets?.every(([, activeSet]) => activeSet === 1), "zapis nie zawiera aktywnego drugiego zestawu broni", persisted.weaponSets);
    const savedPreparation = canonicalJson(persisted.battlePreparation);
    const savedSimulationTime = persisted.combat?.scheduler?.time;

    await click('[data-character-id="korgan"]');
    const exitMoveStart = await debugSnapshot();
    await click("#move-command");
    await clickCanvasHex(3, 3);
    const exitActivation = await waitFor(async () => {
      const debug = await debugSnapshot();
      return debug.phase === "active" ? debug : false;
    }, "aktywacja przez wyjście poza zieloną strefę");
    equal(exitActivation.preparation?.activation?.reason, "left-deployment-zone", "wyjście do czwartej widocznej kolumny aktywuje walkę z właściwym powodem");
    equal(canonicalJson(exitActivation.hexUnits?.find(({ id }) => id === "korgan")?.position), canonicalJson({ q: 3, r: 3 }), "Barbarzyńca rzeczywiście kończy ruch poza strefą rozstawienia");
    const exitMoveCommands = [
      ...(exitActivation.save?.combat?.commands?.active ?? []),
      ...(exitActivation.save?.combat?.commands?.history ?? []),
    ].filter(({ actorId, kind }) => actorId === "korgan" && kind === "move");
    check(exitMoveCommands.length === 1
      && exitMoveCommands[0].recoveryEnd > exitMoveCommands[0].startTick,
    "wyjście poza strefę jest dokładnie jedną rozliczoną akcją ruchu z recovery",
    { before: exitMoveStart.save?.combat, after: exitActivation.save?.combat, exitMoveCommands });

    await storePrimarySave(persisted);
    await loadThroughOptions();
    await waitFor(async () => (await debugSnapshot()).phase === "preparation", "powrót do bazowego przygotowania po teście wyjścia");

    const teethScenario = withEnemyAt(persisted, 2, 5);
    await storePrimarySave(teethScenario);
    await loadThroughOptions();
    await waitFor(async () => (await debugSnapshot()).phase === "preparation", "scenariusz legalnego celu Teeth");
    await click('[data-character-id="ormus"]');
    await click('#cards [data-skill-id="necromancer.teeth"]');
    await clickCanvasHex(2, 5);
    const teethActivation = await waitFor(async () => {
      const debug = await debugSnapshot();
      return debug.phase === "active" ? debug : false;
    }, "aktywacja walki przez ofensywny skill Teeth");
    equal(teethActivation.preparation?.activation?.reason, "offensive-skill", "legalne Teeth aktywuje walkę jako offensive-skill");
    equal(teethActivation.preparation?.activation?.actorId, "ormus", "Ormus pozostaje aktorem ofensywnej aktywacji mimo remisu startowego");
    const teethCommands = [
      ...(teethActivation.save?.combat?.commands?.active ?? []),
      ...(teethActivation.save?.combat?.commands?.history ?? []),
    ].filter(({ actorId, kind, payload }) => actorId === "ormus" && kind === "attack" && payload?.skillId === "necromancer.teeth");
    equal(teethCommands.length, 1, "potwierdzone Teeth tworzy dokładnie jedno polecenie ataku");
    check(teethCommands[0].recoveryEnd > teethCommands[0].startTick, "Teeth jest faktycznie rozliczone z recovery, a nie tylko wizualnie aktywowane", teethCommands[0]);

    await storePrimarySave(persisted);
    await loadThroughOptions();
    await waitFor(async () => (await debugSnapshot()).phase === "preparation", "powrót do bazowego przygotowania po Teeth");

    const adjacentPaladinScenario = withEnemyAt(persisted, 0, 4);
    await storePrimarySave(adjacentPaladinScenario);
    await loadThroughOptions();
    await waitFor(async () => (await debugSnapshot()).phase === "preparation", "scenariusz sąsiedniego celu Paladyna");
    await click('[data-character-id="hadriel"]');
    await click('#cards [data-skill-id="paladin.zeal"]');
    await clickCanvasHex(0, 4);
    const zealActivation = await waitFor(async () => {
      const debug = await debugSnapshot();
      return debug.phase === "active" ? debug : false;
    }, "legalny sąsiedni atak Paladyna");
    equal(zealActivation.preparation?.activation?.reason, "offensive-skill", "sąsiedni Zeal aktywuje walkę jako offensive-skill");
    equal(zealActivation.preparation?.activation?.actorId, "hadriel", "Hadriel pozostaje aktorem sąsiedniego ataku mimo remisu startowego");
    const zealCommands = [
      ...(zealActivation.save?.combat?.commands?.active ?? []),
      ...(zealActivation.save?.combat?.commands?.history ?? []),
    ].filter(({ actorId, kind, payload }) => actorId === "hadriel" && kind === "attack" && payload?.skillId === "paladin.zeal");
    equal(zealCommands.length, 1, "Paladyn stojący dokładnie jeden heks od celu wykonuje jedno polecenie Zeal");
    check(zealCommands[0].recoveryEnd > zealCommands[0].startTick, "legalny sąsiedni atak Paladyna otrzymuje koszt recovery", zealCommands[0]);
    check(!/POZA ZASIĘGIEM/i.test(await query('document.querySelector("#game-toast")?.textContent')), "sąsiedni atak range=1 nie pokazuje fałszywego błędu zasięgu");

    await storePrimarySave(persisted);
    await loadThroughOptions();
    await waitFor(async () => canonicalJson((await debugSnapshot()).preparation) === savedPreparation, "powrót do dokładnego bazowego przygotowania po Zeal");

    await click("#start-battle");
    const active = await waitFor(async () => {
      const debug = await debugSnapshot();
      return debug.phase === "active" ? debug : false;
    }, "przejście z preparation do active");
    equal(active.enemyTurnsEnabled, true, "jawny start walki włącza tury przeciwników");
    equal(active.enemyAwarenessEnabled, true, "jawny start walki włącza świadomość przeciwników");
    const activeUi = await uiSnapshot();
    equal(activeUi.phase, "active", "DOM pokazuje fazę active po rozpoczęciu starcia");
    check(!/AI\s+UŚPIONE/i.test(activeUi.queueState), "HUD zdejmuje stan uśpionego AI po rozpoczęciu walki", activeUi.queueState);
    check(activeUi.queueTokens > 0, "po rozpoczęciu walki widoczna jest aktywna kolejka", activeUi);
    check(Boolean(active.save?.combat?.readiness?.currentActorId)
      || (active.save?.combat?.scheduler?.queue?.length ?? 0) > 0,
    "autorytatywna kolejka ma bieżącego aktora albo zaplanowane zdarzenia",
    active.save?.combat);

    await click('[data-open-panel="options"]');
    await waitFor(() => query('Boolean(document.querySelector("#load-save"))'), "przycisk wczytania zapisu");
    await click("#load-save");
    const restored = await waitFor(async () => {
      const debug = await debugSnapshot();
      return debug.phase === "preparation" ? debug : false;
    }, "odtworzenie fazy preparation z zapisu");
    equal(canonicalJson(restored.preparation), savedPreparation, "WCZYTAJ odtwarza dokładny snapshot preparation/loadouts/summons");
    equal(restored.save?.combat?.scheduler?.time, savedSimulationTime, "WCZYTAJ odtwarza zapisany czas symulacji");
    equal(restored.enemyTurnsEnabled, false, "WCZYTAJ ponownie usypia AI zgodnie z zapisem preparation");
    equal((await uiSnapshot()).phase, "preparation", "UI po wczytaniu wraca do przygotowania");

    await click("#start-battle");
    const activeBeforeLoadout = await waitFor(async () => {
      const debug = await debugSnapshot();
      return debug.phase === "active" && debug.actingUnitId ? debug : false;
    }, "ponowny start odtworzonego starcia");
    const loadoutActorId = activeBeforeLoadout.actingUnitId;
    const activeLoadoutBefore = activeBeforeLoadout.preparation.loadouts.find(({ heroId }) => heroId === loadoutActorId);
    const commandCountBeforeLoadout = (activeBeforeLoadout.save.combat.commands.active?.length ?? 0)
      + (activeBeforeLoadout.save.combat.commands.history?.length ?? 0);
    await click("#change-loadout");
    const activeAfterLoadout = await debugSnapshot();
    const activeLoadoutAfter = activeAfterLoadout.preparation.loadouts.find(({ heroId }) => heroId === loadoutActorId);
    check(canonicalJson(activeLoadoutAfter) !== canonicalJson(activeLoadoutBefore), "ZMIEŃ SKILL faktycznie modyfikuje loadout aktywnego bohatera", { loadoutActorId, activeLoadoutBefore, activeLoadoutAfter });
    const allCommandsAfterLoadout = [
      ...(activeAfterLoadout.save.combat.commands.active ?? []),
      ...(activeAfterLoadout.save.combat.commands.history ?? []),
    ];
    equal(allCommandsAfterLoadout.length, commandCountBeforeLoadout + 1, "zmiana loadoutu w active tworzy dokładnie jedno nowe polecenie");
    const loadoutCommand = allCommandsAfterLoadout.find(({ actorId, kind, payload }) => (
      actorId === loadoutActorId && kind === "cast" && payload?.skillChange
    ));
    check(loadoutCommand?.recoveryEnd > loadoutCommand?.startTick, "zmiana loadoutu w walce kosztuje pełną kolejkę z recovery", loadoutCommand);
    check(activeAfterLoadout.preparation.actionSequence > activeBeforeLoadout.preparation.actionSequence, "rejestr przygotowania zapisuje zmianę loadoutu oraz rozliczenie tury", {
      before: activeBeforeLoadout.preparation.actionSequence,
      after: activeAfterLoadout.preparation.actionSequence,
    });

    await click("#save");
    const activePersisted = await query(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);
    equal(activePersisted.battlePreparation?.phase, "active", "zapis v3 utrwala aktywną fazę walki");
    equal(canonicalJson(activePersisted.battlePreparation), canonicalJson(activeAfterLoadout.preparation), "aktywny zapis utrwala loadouty, buffy i summonów bez utraty danych");
    const activeSavedCombat = canonicalJson(activePersisted.combat);
    const activeSavedPreparation = canonicalJson(activePersisted.battlePreparation);

    await waitFor(() => query('!document.querySelector("#end-turn")?.disabled'), "aktywna kontrolka zakończenia kolejki");
    await click("#end-turn");
    check(canonicalJson((await debugSnapshot()).save.combat) !== activeSavedCombat, "akcja po aktywnym zapisie rzeczywiście mutuje stan walki");
    await loadThroughOptions();
    const restoredActive = await waitFor(async () => {
      const debug = await debugSnapshot();
      return debug.phase === "active" ? debug : false;
    }, "odtworzenie aktywnej fazy z zapisu");
    equal(canonicalJson(restoredActive.preparation), activeSavedPreparation, "WCZYTAJ odtwarza dokładny aktywny battlePreparation");
    equal(canonicalJson(restoredActive.save.combat), activeSavedCombat, "WCZYTAJ odtwarza dokładną aktywną kolejkę, polecenia i zegar");
    equal(restoredActive.enemyTurnsEnabled, true, "wczytana aktywna walka zachowuje włączone tury AI");

    const liveBeforeMalformedLoad = await debugSnapshot();
    const malformed = structuredClone(activePersisted);
    malformed.battlePreparation.rules.deploymentColumns = 2;
    await storePrimarySave(malformed, { removeFallbacks: true });
    await loadThroughOptions();
    const liveAfterMalformedLoad = await debugSnapshot();
    equal(canonicalJson(liveAfterMalformedLoad.save), canonicalJson(liveBeforeMalformedLoad.save), "uszkodzone battlePreparation jest odrzucone atomowo bez mutacji żywej sesji");
    const malformedFeedback = await query(`(() => ({
      panelOpen: !document.querySelector("#panel-layer")?.classList.contains("hidden"),
      toast: document.querySelector("#game-toast")?.textContent?.replace(/\\s+/g, " ")?.trim(),
      kind: document.querySelector("#game-toast")?.dataset.kind,
    }))()`);
    check(malformedFeedback.panelOpen && /NIE UDAŁO SIĘ WCZYTAĆ/i.test(malformedFeedback.toast), "UI jawnie zgłasza odrzucenie uszkodzonego nowego pola zapisu", malformedFeedback);
    await click("#close-panel");
    await storePrimarySave(activePersisted);

    const crossClassLoadout = structuredClone(activePersisted);
    crossClassLoadout.battlePreparation.loadouts
      .find(({ heroId }) => heroId === "korgan").left = "paladin.smite";
    await storePrimarySave(crossClassLoadout, { removeFallbacks: true });
    const beforeCrossClassLoad = await debugSnapshot();
    await loadThroughOptions();
    const afterCrossClassLoad = await debugSnapshot();
    equal(canonicalJson(afterCrossClassLoad.save), canonicalJson(beforeCrossClassLoad.save), "skill obcej klasy w loadoucie jest odrzucony atomowo");
    const crossClassFeedback = await query(`(() => ({
      panelOpen: !document.querySelector("#panel-layer")?.classList.contains("hidden"),
      toast: document.querySelector("#game-toast")?.textContent?.replace(/\\s+/g, " ")?.trim(),
      kind: document.querySelector("#game-toast")?.dataset.kind,
    }))()`);
    check(crossClassFeedback.panelOpen && /NIE UDAŁO SIĘ WCZYTAĆ/i.test(crossClassFeedback.toast), "UI jawnie odrzuca podmieniony skill obcej klasy", crossClassFeedback);
    await click("#close-panel");
    await storePrimarySave(activePersisted);

    let warCry = (await debugSnapshot()).preparation.buffs.find(({ skillId }) => skillId === "barbarian.battle_orders");
    check(Number.isSafeInteger(warCry?.remainingTurns) && warCry.remainingTurns > 0, "aktywny zapis zachowuje dodatnią liczbę tur Battle Orders", warCry);
    const observedTurns = [warCry.remainingTurns];
    for (let turn = 0; warCry && turn < 12; turn += 1) {
      await waitFor(() => query('!document.querySelector("#end-turn")?.disabled'), `gotowość do kolejki wygaszającej okrzyk ${turn + 1}`);
      await click("#end-turn");
      warCry = (await debugSnapshot()).preparation.buffs.find(({ skillId }) => skillId === "barbarian.battle_orders");
      observedTurns.push(warCry?.remainingTurns ?? null);
    }
    check(observedTurns.slice(1).every((value, index) => value === null || value < observedTurns[index]), "Battle Orders maleje po każdej rozliczonej akcji gracza lub AI", observedTurns);
    equal(observedTurns.at(-1), null, "Battle Orders wygasa w skończonej liczbie wspólnych kolejek");
    check(!(await debugSnapshot()).preparation.buffs.some(({ skillId }) => skillId === "barbarian.battle_orders"), "czasowy okrzyk nie pozostaje po wyczerpaniu tur");

    await delay(150);
    check(runtimeErrors.length === 0, "cały test v0.5 kończy się bez nieobsłużonych błędów JavaScript", runtimeErrors);
    check(httpErrors.length === 0, "cały test v0.5 kończy się bez odpowiedzi HTTP 4xx/5xx", httpErrors);
    process.stdout.write(`PASS: ${assertions.length} asercji UI v0.5, Edge headless, bez widocznego okna.\n`);
  } finally {
    cdp?.close();
    await cleanupTrackedBrowser(edge);
    emergencyBrowser = null;
    emergencyCdp = null;
  }
}

const hardTimeout = setTimeout(async () => {
  process.stderr.write(`FAIL UI v0.5: twardy timeout ${HARD_TIMEOUT_MS} ms\n`);
  emergencyCdp?.close();
  await cleanupTrackedBrowser(emergencyBrowser).catch(() => {});
  process.exit(1);
}, HARD_TIMEOUT_MS);

run().then(() => {
  clearTimeout(hardTimeout);
}).catch((error) => {
  clearTimeout(hardTimeout);
  process.stderr.write(`FAIL UI v0.5: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
