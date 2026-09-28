import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_BROWSER_SAVE_BYTES, readBrowserSave, writeBrowserSave } from '../src/node/browser-save-store.js';
import { RELEASE_VERSION, checkGitHubRelease, downloadVerifiedInstaller, launchInstaller } from '../src/node/release-updates.js';

const root = process.cwd();
const portFlag = process.argv.indexOf("--port");
const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : (process.env.GAME_PORT || 4173));
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new RangeError("Port must be an integer from 1024 to 65535");
}
const HEALTH_PATH = "/__rotw_health";
const SAVE_PATH = '/__rotw_save';
const UPDATE_PATH = '/__rotw_update';
const APP_ID = "reign-of-the-warlock-turn-based";
// Browser tests provide a disposable path; the desktop launcher uses the
// stable project-local file regardless of the origin port selected at startup.
const saveFile = process.env.ROTW_SAVE_FILE
  ? path.resolve(process.env.ROTW_SAVE_FILE)
  : path.join(root, 'work', 'player-save-v3.json');
const expectedHost = `127.0.0.1:${port}`;
const expectedOrigin = `http://${expectedHost}`;
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
let updateCache = null;

async function latestUpdate({ force = false } = {}) {
  if (!force && updateCache && Date.now() - updateCache.checkedAt < 60_000) return updateCache.release;
  const release = await checkGitHubRelease({ signal: AbortSignal.timeout(8_000) });
  updateCache = { checkedAt: Date.now(), release };
  return release;
}

async function requestJson(request) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BROWSER_SAVE_BYTES * 2 + 1024) throw new Error('Żądanie zapisu jest za duże');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer(async (request, response) => {
  try {
    if (request.headers.host !== expectedHost) {
      response.writeHead(403, jsonHeaders);
      response.end(JSON.stringify({ error: 'Niedozwolony adres serwera gry' }));
      return;
    }
    const urlPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    if (urlPath === HEALTH_PATH) {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ app: APP_ID, projectRoot: root, pid: process.pid, port, saveApiVersion: 1 }));
      return;
    }
    if (urlPath === SAVE_PATH) {
      if (request.method === 'GET') {
        const saves = await readBrowserSave(saveFile);
        response.writeHead(200, jsonHeaders);
        response.end(JSON.stringify(saves));
        return;
      }
      if (request.method === 'POST') {
        if (request.headers.origin !== expectedOrigin
          || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
          response.writeHead(403, jsonHeaders);
          response.end(JSON.stringify({ error: 'Niedozwolone źródło zapisu' }));
          return;
        }
        try {
          const body = await requestJson(request);
          await writeBrowserSave(saveFile, body?.raw, {
            preserveBackup: body?.preserveBackup === true,
            preservePrimary: body?.preservePrimary === true,
            preserveInvalidBackup: body?.preserveInvalidBackup === true,
          });
          response.writeHead(200, jsonHeaders);
          response.end(JSON.stringify({ saved: true }));
        } catch (error) {
          response.writeHead(409, jsonHeaders);
          response.end(JSON.stringify({ error: error.message }));
        }
        return;
      }
      response.writeHead(405, { ...jsonHeaders, allow: 'GET, POST' });
      response.end(JSON.stringify({ error: 'Niedozwolona metoda' }));
      return;
    }
    if (urlPath === UPDATE_PATH) {
      if (request.method === 'GET') {
        try {
          const release = await latestUpdate();
          response.writeHead(200, jsonHeaders);
          response.end(JSON.stringify(release));
        } catch (error) {
          response.writeHead(503, jsonHeaders);
          response.end(JSON.stringify({ currentVersion: RELEASE_VERSION, updateAvailable: false,
            error: `Nie można sprawdzić wydań GitHub: ${error.message}` }));
        }
        return;
      }
      if (request.method === 'POST') {
        if (request.headers.origin !== expectedOrigin ||
            !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
          response.writeHead(403, jsonHeaders);
          response.end(JSON.stringify({ error: 'Niedozwolone źródło aktualizacji.' }));
          return;
        }
        try {
          const body = await requestJson(request);
          if (body?.action !== 'install') throw new Error('Nieznana operacja aktualizacji.');
          const release = await latestUpdate({ force: true });
          if (!release.updateAvailable) throw new Error(release.error || 'Nie ma nowszej wersji z instalatorem.');
          const installerPath = await downloadVerifiedInstaller(release, { signal: AbortSignal.timeout(15 * 60_000) });
          await launchInstaller(installerPath, { installDirectory: root });
          response.writeHead(200, jsonHeaders);
          response.end(JSON.stringify({ started: true, version: release.latestVersion,
            message: 'Zweryfikowany instalator został uruchomiony. Dokończ instalację w jego oknie.' }));
        } catch (error) {
          response.writeHead(409, jsonHeaders);
          response.end(JSON.stringify({ error: `Nie udało się zainstalować aktualizacji: ${error.message}` }));
        }
        return;
      }
      response.writeHead(405, { ...jsonHeaders, allow: 'GET, POST' });
      response.end(JSON.stringify({ error: 'Niedozwolona metoda.' }));
      return;
    }
    if (urlPath.toLowerCase() === '/work' || urlPath.toLowerCase().startsWith('/work/')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const relative = urlPath === "/" ? "app/index.html" : urlPath.replace(/^\//, "");
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(root + path.sep)) throw new Error("Invalid path");
    const info = await stat(candidate);
    const file = info.isDirectory() ? path.join(candidate, "index.html") : candidate;
    response.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Offline preview: http://127.0.0.1:${port}`);
});
