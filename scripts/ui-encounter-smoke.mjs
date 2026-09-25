import { runEncounterBrowserChecks } from './encounter-browser-checks.mjs';
import { readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import path from "node:path";
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from "./browser-lifecycle.mjs";

const APP_URL = process.env.ROTW_UI_URL ?? "http://127.0.0.1:4173/";
const EDGE_PATH = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SAVE_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1";
const SAVE_BACKUP_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1-backup";
const LEGACY_SAVE_KEY = "rotw-prototype-save-v2";
const STEP_TIMEOUT_MS = 15_000;
const EDGE_STARTUP_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 120_000;

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

async function launchHeadlessEdge() {
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
  let edge, cdp;
  try {
    edge=await launchHeadlessEdge(); emergencyBrowser=edge; cdp=new CdpClient(edge.target.webSocketDebuggerUrl);
    emergencyCdp=cdp; await cdp.connect();
    const errors=[];
    cdp.on('Runtime.exceptionThrown', p=>errors.push(p.exceptionDetails?.text));
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.navigate',{url:APP_URL});
    const evaluate=async expression=>{
      const result=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
      if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    };
    await waitFor(()=>evaluate('!!window.__rotwDebug?.equipment'),'ready equipment runtime');
    const results=await evaluate('('+runEncounterBrowserChecks.toString()+')()');
    assert(errors.length===0,'No unhandled JavaScript errors',errors);
    console.log(`PASS: ${results.length} encounter UI assertions (HTTP / native localStorage / isolated Edge headless profile).`);
    for(const label of results)console.log('  PASS '+label);
  } finally {
    cdp?.close();await cleanupTrackedBrowser(edge);
    emergencyBrowser=null;emergencyCdp=null;
  }
}
const hardTimeout = setTimeout(async () => {
  process.stderr.write(`FAIL UI encounters v0.5.3: twardy timeout ${HARD_TIMEOUT_MS} ms\n`);
  emergencyCdp?.close();
  await cleanupTrackedBrowser(emergencyBrowser).catch(() => {});
  process.exit(1);
}, HARD_TIMEOUT_MS);

run().then(() => {
  clearTimeout(hardTimeout);
}).catch((error) => {
  clearTimeout(hardTimeout);
  process.stderr.write(`FAIL UI encounters v0.5.3: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
