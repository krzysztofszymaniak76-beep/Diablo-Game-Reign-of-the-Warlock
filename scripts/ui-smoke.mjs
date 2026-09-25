import { mkdir, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import path from "node:path";
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from "./browser-lifecycle.mjs";

const APP_URL = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4173/?training=1";
const EDGE_PATH = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SAVE_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1";
const KEYBINDING_KEY = "rotw.keybindings";
const STEP_TIMEOUT_MS = 12_000;
const EDGE_STARTUP_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 120_000;

let emergencyBrowser = null;
let emergencyCdp = null;
installGlobalCleanupHandlers();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message, detail) {
  const suffix = detail === undefined ? "" : `\n  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
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
      const value = await predicate();
      if (value) return value;
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
    fail(`Aplikacja nie odpowiada pod ${APP_URL}. Uruchom najpierw serwer.`, error.message);
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

async function launchHeadlessEdge() {
  process.stdout.write("  · uruchamiam Edge headless (izolowany port CDP)\n");
  const browser = await launchTrackedBrowser({ edgePath: EDGE_PATH, appUrl: APP_URL, windowSize: "1536,1024", startupTimeoutMs: EDGE_STARTUP_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(`  · Edge przydzielił port CDP ${browser.port}\n`);
  process.stdout.write("  · cel CDP odnaleziony\n");
  return { ...browser, target: browser.target, stderr: browser.stderr };
}

async function run() {
  await requireServer();
  let edge;
  let cdp;
  const assertions = [];
  const runtimeErrors = [];
  const httpErrors = [];

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
    process.stdout.write(`Smoke UI: ${APP_URL}\n`);
    edge = await launchHeadlessEdge();
    emergencyBrowser = edge;
    process.stdout.write("  · Edge headless i CDP gotowe\n");
    cdp = new CdpClient(edge.target.webSocketDebuggerUrl);
    emergencyCdp = cdp;
    await cdp.connect();
    process.stdout.write("  · WebSocket CDP połączony\n");

    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      runtimeErrors.push(`uncaught: ${exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? "nieznany wyjątek"}`);
    });
    cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
      if (type !== "error" && type !== "assert") return;
      runtimeErrors.push(`console.${type}: ${args.map((item) => item.value ?? item.description ?? "").join(" ")}`);
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
    await cdp.send("Page.bringToFront");
    process.stdout.write("  · domeny Runtime/Page/Log aktywne\n");

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

    const capture = async (fileName) => {
      const outputDirectory = path.resolve("work");
      await mkdir(outputDirectory, { recursive: true });
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const output = path.join(outputDirectory, fileName);
      await writeFile(output, Buffer.from(data, "base64"));
      process.stdout.write(`  ↳ screenshot: ${output}\n`);
    };

    const query = (expression) => evaluate(`(() => (${expression}))()`);
    const state = () => query(`({
      ready: document.readyState,
      heroes: document.querySelectorAll("#party .hero").length,
      acting: document.querySelector("#acting-name")?.textContent?.trim(),
      inspected: document.querySelector("#inspected-name-side")?.textContent?.trim(),
      sim: document.querySelector("#sim-time")?.textContent?.trim(),
      phase: document.querySelector(".battle-state")?.dataset.battlePhase,
      enemiesEnabled: document.body.dataset.enemyTurnsEnabled,
      panelHidden: document.querySelector("#panel-layer")?.classList.contains("hidden"),
      panelTitle: document.querySelector("#panel-title")?.textContent?.trim(),
      panelClass: document.querySelector("#panel-body")?.className,
      targetingHidden: document.querySelector("#targeting-banner")?.classList.contains("hidden"),
      targetingText: document.querySelector("#targeting-copy")?.textContent?.trim(),
      pauseHidden: document.querySelector("#pause-overlay")?.classList.contains("hidden")
    })`);

    const keyDefinitions = {
      KeyI: { key: "i", virtualKeyCode: 73 },
      KeyB: { key: "b", virtualKeyCode: 66 },
      KeyP: { key: "p", virtualKeyCode: 80 },
      Tab: { key: "Tab", virtualKeyCode: 9 },
      Escape: { key: "Escape", virtualKeyCode: 27 },
    };
    const press = async (code) => {
      const definition = keyDefinitions[code];
      if (!definition) fail(`Brak definicji klawisza ${code}`);
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
      await delay(80);
    };

    const centerOf = async (selector) => query(`(() => {
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
      assert(point && point.width > 0 && point.height > 0, `Nie można kliknąć ${selector}`, point);
      await clickPoint(point.x, point.y);
    };
    // Some retained commands (cards, loadout, sidebar options) are intentionally
    // outside the current visible HUD. Exercise their real click handlers
    // explicitly; never invent screen coordinates for a zero-size control.
    const activateLegacyCommand = async (selector) => {
      const outcome = await query(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return { ok: false, reason: "missing" };
        if (element.disabled) return { ok: false, reason: "disabled" };
        const rect = element.getBoundingClientRect();
        const hidden = element.closest(".hidden, .legacy-utility-hooks")
          || getComputedStyle(element).display === "none"
          || rect.width === 0 || rect.height === 0;
        if (!hidden) return { ok: false, reason: "not-legacy-hidden" };
        element.click();
        return { ok: true };
      })()`);
      assert(outcome?.ok, `Nie można uruchomić ukrytego polecenia ${selector}`, outcome);
      await delay(100);
    };

    const initial = await waitFor(async () => {
      const snapshot = await state();
      if (snapshot.ready !== "complete" || snapshot.heroes !== 3 || snapshot.phase !== "preparation") return false;
      const origin = await query("performance.timeOrigin");
      await delay(250);
      const stable = await query(`({
        origin: performance.timeOrigin,
        heroes: document.querySelectorAll("#party .hero").length,
        phase: document.body.dataset.battlePhase
      })`);
      return stable.origin === origin && stable.heroes === 3 && stable.phase === "preparation" ? snapshot : false;
    }, "stabilny start fazy przygotowania v0.5");
    equal(initial.heroes, 3, "aplikacja renderuje dokładnie trzech aktywnych bohaterów");
    equal(initial.acting, "Korgan", "przygotowanie rozpoczyna Korgan");
    equal(initial.inspected, "Korgan", "początkowy podgląd wskazuje Korgana");
    equal(initial.phase, "preparation", "start następuje w fazie preparation");
    equal(initial.enemiesEnabled, "false", "wrogowie i ich kolejka są uśpieni w przygotowaniu");
    check(runtimeErrors.length === 0, "start przebiega bez nieobsłużonych błędów JavaScript", runtimeErrors);

    const initialSim = initial.sim;
    const initialDebug = await query(`globalThis.__rotwDebug.snapshot()`);
    equal(initialDebug.save.partyIds.join(","), "korgan,hadriel,ormus", "model zapisuje aktywną trójkę Korgan/Hadriel/Ormus");
    equal(initialDebug.save.hexGrid.tiles.length, 213, "pole bitwy zawiera 213 pełnych heksów zgodnych ze wzorem");
    equal(initialDebug.save.combat.readiness.currentActorId, null, "scheduler nie otwiera tury przeciwnika podczas przygotowania");
    equal(await query(`document.querySelectorAll("[data-deployment-zone]").length`), 1, "interfejs oznacza zieloną strefę rozstawienia");

    const korganCards = await query(`[...document.querySelectorAll("#cards .skill-card")].map((card) => ({ id: card.dataset.skillId, role: card.dataset.slotRole, right: card.dataset.rightIndex ?? null }))`);
    equal(korganCards.length, 4, "aktywny bohater ma dokładnie cztery karty umiejętności");
    equal(korganCards.map(({ id }) => id).join(","), "barbarian.bash,barbarian.battle_orders,barbarian.shout,barbarian.whirlwind", "Barbarzyńca dostaje własny loadout 1 LPM + 3 PPM");
    equal(korganCards.map(({ role }) => role).join(","), "left,right,right,right", "role slotów kart to jedno LPM i trzy PPM");
    check(!korganCards.some(({ id }) => id.includes("basic")), "talia nie zawiera zastępczego ataku podstawowego", korganCards);

    await activateLegacyCommand('#cards .skill-card[data-right-index="0"]');
    let snapshot = await state();
    equal(snapshot.phase, "preparation", "Battle Orders nie uruchamia walki w przygotowaniu");
    equal(snapshot.sim, initialSim, "okrzyk w przygotowaniu nie przesuwa zegara");
    check((await query(`document.querySelector("#warcry-status")?.textContent`)).includes("Battle Orders"), "licznik statusu pokazuje aktywny Battle Orders");

    await click('[data-character-id="hadriel"]');
    snapshot = await state();
    equal(snapshot.acting, "Hadriel", "w przygotowaniu portret wybiera bohatera wydającego rozkaz");
    equal(snapshot.inspected, "Hadriel", "portret przełącza podgląd na Hadriela");
    equal(await query(`document.querySelector("#skill-card-left")?.dataset.skillId`), "paladin.zeal", "Paladyn ma klasowy atak Zeal w lewym slocie");
    await activateLegacyCommand('#cards .skill-card[data-right-index="0"]');
    equal((await state()).sim, initialSim, "aura Might w przygotowaniu jest darmowa");
    check((await query(`document.querySelector("#aura-status")?.textContent`)).includes("Might"), "status pokazuje aktywną aurę Paladyna");

    await click('[data-character-id="ormus"]');
    equal(await query(`document.querySelector("#skill-card-left")?.dataset.skillId`), "necromancer.teeth", "Nekromanta ma własną kartę Teeth w lewym slocie");
    await activateLegacyCommand('#cards .skill-card[data-right-index="0"]');
    const afterSummon = await query(`globalThis.__rotwDebug.snapshot()`);
    equal(afterSummon.preparation.summons.length, 0, "Raise Skeleton bez zwłok nie tworzy nielegalnego summona");
    check(/Wymaga dostępnych zwłok/i.test(await query(`document.querySelector("#game-toast")?.textContent`)), "UI wyjaśnia wymaganie zwłok dla Raise Skeleton");
    equal((await state()).sim, initialSim, "odrzucone przywołanie w przygotowaniu nie przesuwa zegara");

    const loadoutBefore = await query(`document.querySelector('#cards .skill-card[data-right-index="2"]')?.dataset.skillId`);
    await activateLegacyCommand("#change-loadout");
    const loadoutAfter = await query(`document.querySelector('#cards .skill-card[data-right-index="2"]')?.dataset.skillId`);
    check(loadoutAfter !== loadoutBefore, "zmiana PPM 3 podmienia realną kartę loadoutu", { loadoutBefore, loadoutAfter });
    equal(loadoutAfter, "necromancer.corpse_explosion", "alternatywną kartą Nekromanty jest Corpse Explosion");
    equal((await state()).sim, initialSim, "zmiana loadoutu w przygotowaniu jest darmowa");

    equal(await query(`globalThis.__rotwDebug.snapshot().save.belts.find(([id]) => id === "ormus")[1][0]`), null, "nowa postać ma pusty pas");
    check(await query(`document.querySelector("#hud-belt-slot-1")?.disabled`), "pustego miejsca pasa nie można użyć");
    equal((await state()).phase, "preparation", "pusty pas nie budzi przeciwników w przygotowaniu");

    await press("KeyI");
    snapshot = await state();
    check(!snapshot.panelHidden && snapshot.panelClass.includes("inventory-view"), "I otwiera rzeczywisty widok ekwipunku");
    equal(snapshot.sim, initialSim, "otwarcie ekwipunku nie zmienia czasu symulacji");
    const inventoryGeometry = await query(`(() => {
      const cells = [...document.querySelectorAll("#inventory-grid .inventory-cell")];
      const rows = new Map();
      for (const cell of cells) {
        const top = Math.round(cell.getBoundingClientRect().top);
        rows.set(top, (rows.get(top) ?? 0) + 1);
      }
      return {
        cells: cells.length,
        rowCounts: [...rows.values()],
        weaponButtons: [...document.querySelectorAll(".d2-empty-weapon-tabs button")].map((button) => ({
          set: button.dataset.weaponSet, disabled: button.disabled,
        })),
      };
    })()`);
    equal(inventoryGeometry.cells, 40, "plecak renderuje 40 fizycznych pól");
    check(inventoryGeometry.rowCounts.length === 4 && inventoryGeometry.rowCounts.every((count) => count === 10), "plecak renderuje dokładnie 4 rzędy po 10 pól", inventoryGeometry);
    equal(inventoryGeometry.weaponButtons.length, 4, "ekwipunek pokazuje dwie pary zakładek wzorca");
    check(inventoryGeometry.weaponButtons.filter(button => button.set === '1' && !button.disabled).length === 2
      && inventoryGeometry.weaponButtons.filter(button => button.set === '2' && button.disabled).length === 2,
    "tylko pierwszy zestaw broni jest aktywny zgodnie z mechaniką", inventoryGeometry.weaponButtons);
    await capture("inventory-panel-v05-1536x1024.png");
    await press("Escape");

    await press("Tab");
    snapshot = await state();
    check(!snapshot.panelHidden && snapshot.panelClass.includes("map-view"), "Tab otwiera mapę na żądanie");
    equal(snapshot.sim, initialSim, "mapa nie zmienia czasu symulacji");
    await press("Escape");
    await press("Escape");
    check(!(await state()).pauseHidden, "Escape bez panelu otwiera pauzę");
    await press("Escape");
    check((await state()).pauseHidden, "Escape ponownie zamyka pauzę");

    await activateLegacyCommand('[data-open-panel="options"]');
    const bindingBefore = await query(`localStorage.getItem(${JSON.stringify(KEYBINDING_KEY)})`);
    await evaluate(`(() => {
      const input = document.querySelector('[data-action-binding="inventory"]');
      input.value = "KeyP";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await click("#save-shortcuts");
    const conflict = await query(`(() => {
      const element = document.querySelector("#shortcut-conflict");
      return { kind: element?.dataset.kind, hidden: element?.classList.contains("hidden"), text: element?.textContent?.trim(), stored: localStorage.getItem(${JSON.stringify(KEYBINDING_KEY)}) };
    })()`);
    equal(conflict.kind, "error", "konflikt skrótu jest wykryty przed zapisem");
    check(!conflict.hidden && conflict.text.includes("Konflikt"), "interfejs pokazuje czytelny komunikat konfliktu");
    equal(conflict.stored, bindingBefore, "konfliktujący remap nie trafia do localStorage");
    await press("Escape");

    await click('[data-character-id="korgan"]');
    await click("#save");
    const saved = await query(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);
    equal(saved.schemaVersion, 3, "zapis nadal używa zgodnego schematu v3");
    equal(saved.game_ruleset_version, "rotw-hex-combat-v0.5.0-preparation-adaptation", "zapis utrwala ruleset v0.5 przygotowania");
    equal(saved.partyIds.join(","), "korgan,hadriel,ormus", "zapis nie przywraca starej czteroosobowej drużyny");
    equal(saved.battlePreparation.phase, "preparation", "zapis utrwala fazę przygotowania");
    equal(saved.battlePreparation.summons.length, 0, "zapis nie wprowadza nielegalnego summona bez zwłok");
    check(saved.battlePreparation.buffs.length >= 2, "zapis utrwala okrzyk i aurę", saved.battlePreparation.buffs);
    check(saved.weaponSets.every(([, value]) => value === 1), "zapis dopuszcza wyłącznie jeden zestaw broni", saved.weaponSets);

    await activateLegacyCommand("#change-loadout");
    const loadoutsAfterSave = await query(`globalThis.__rotwDebug.snapshot().preparation.loadouts`);
    check(JSON.stringify(loadoutsAfterSave) !== JSON.stringify(saved.battlePreparation.loadouts), "akcja po zapisie realnie zmienia przygotowanie", { before: saved.battlePreparation.loadouts, after: loadoutsAfterSave });
    await activateLegacyCommand('[data-open-panel="options"]');
    await click("#load-save");
    snapshot = await state();
    equal(snapshot.phase, "preparation", "wczytanie przywraca zapisaną fazę preparation");
    equal(snapshot.acting, "Korgan", "wczytanie przywraca wybranego bohatera przygotowania");
    equal(await query(`globalThis.__rotwDebug.snapshot().preparation.buffs.length`), saved.battlePreparation.buffs.length, "wczytanie przywraca dokładny zestaw buffów");
    check(snapshot.panelHidden, "wczytanie zamyka panel i wraca do pola walki");

    await click("#start-battle");
    snapshot = await waitFor(async () => {
      const current = await state();
      return current.phase === "active" && current.acting ? current : false;
    }, "jawne przejście preparation → active");
    equal(snapshot.phase, "active", "ROZPOCZNIJ STARCIE aktywuje walkę dokładnie raz");
    equal(snapshot.enemiesEnabled, "true", "po starcie przeciwnicy otrzymują dostęp do wspólnej kolejki");
    equal(snapshot.acting, "Korgan", "jawny start zachowuje pierwszeństwo wybranego Korgana");
    const activeBefore = await query(`globalThis.__rotwDebug.snapshot()`);
    const activeCardBefore = await query(`document.querySelector('#cards .skill-card[data-right-index="2"]')?.dataset.skillId`);
    await activateLegacyCommand("#change-loadout");
    const activeAfter = await query(`globalThis.__rotwDebug.snapshot()`);
    check(activeAfter.preparation.actionSequence > activeBefore.preparation.actionSequence, "zmiana loadoutu w aktywnej walce zużywa kolejkę", { before: activeBefore.preparation.actionSequence, after: activeAfter.preparation.actionSequence });
    check((await query(`document.querySelector('#cards .skill-card[data-right-index="2"]')?.dataset.skillId`)) !== activeCardBefore || activeAfter.actingUnitId !== activeBefore.actingUnitId, "aktywna zmiana loadoutu została rozliczona przez model", { activeBefore, activeAfter });

    await delay(150);
    check(runtimeErrors.length === 0, "cały smoke test kończy się bez nieobsłużonych błędów JavaScript", runtimeErrors);
    check(httpErrors.length === 0, "cały smoke test kończy się bez odpowiedzi HTTP 4xx/5xx", httpErrors);
    process.stdout.write(`PASS: ${assertions.length} asercji UI, Edge headless, bez widocznego okna.\n`);
  } finally {
    cdp?.close();
    await cleanupTrackedBrowser(edge);
    emergencyBrowser = null;
    emergencyCdp = null;
  }
}

const hardTimeout = setTimeout(async () => {
  process.stderr.write(`FAIL UI: twardy timeout ${HARD_TIMEOUT_MS} ms\n`);
  emergencyCdp?.close();
  await cleanupTrackedBrowser(emergencyBrowser).catch(() => {});
  process.exit(1);
}, HARD_TIMEOUT_MS);

run().then(() => {
  clearTimeout(hardTimeout);
}).catch((error) => {
  clearTimeout(hardTimeout);
  process.stderr.write(`FAIL UI: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
