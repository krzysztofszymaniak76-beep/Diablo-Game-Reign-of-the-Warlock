// Headless acceptance for three visible heroes beside the Rogue Encampment stash.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUTPUT = path.resolve('docs/evidence/camp-party-heroes/camp-three-heroes-1920x1080.png');
const STASH_OUTPUT = path.resolve('docs/evidence/camp-party-heroes/camp-stash-inventory-1920x1080.png');
const EVIDENCE_DIR = path.resolve('docs/evidence/canonical-hero-art');
const pending = new Map();
const errors = [];
let browser;
let socket;
let sequence = 0;
installGlobalCleanupHandlers();

function check(ok, label, details) {
  if (!ok) throw new Error(`${label}: ${JSON.stringify(details)}`);
  console.log(`PASS ${label}`);
}

async function saveScreenshot(name) {
  const captureResult = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  const file = path.join(EVIDENCE_DIR, `${name}-1920x1080.png`);
  await writeFile(file, Buffer.from(captureResult.data, 'base64'));
  console.log(`SCREENSHOT ${file}`);
}

function send(method, params = {}) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result?.value;
}

async function until(expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timeout: ${label}`);
}

async function main() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), {
    signal: AbortSignal.timeout(5000),
  })).json();
  check(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    'Serwer wskazuje bieżący projekt', health);
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  browser = await launchTrackedBrowser({
    appUrl: 'about:blank', windowSize: '1920,1080', stdio: ['ignore', 'ignore', 'pipe'],
  });
  socket = new WebSocket(browser.target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(typeof data === 'string' ? data : await data.text());
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled'
      && ['error', 'assert'].includes(message.params.type)) {
      errors.push(message.params.args?.map(arg => arg.value ?? arg.description).join(' '));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('rotw.music.volume.v1', '0.05'); } catch {}",
  });
  await send('Page.navigate', { url: APP_URL });
  await until('Boolean(window.__rotwDebug?.snapshot) && !document.querySelector("#main-menu").hidden',
    'Menu startowe');
  await evaluate('document.querySelector("#menu-new-game").click()');
  await until('document.querySelector("#character-creation")?.getAttribute("aria-hidden") === "false"',
    'Wybór postaci');
  await evaluate(`(() => {
    for (const id of ['korgan', 'hadriel', 'ormus']) {
      const button = document.querySelector('.character-creation-class[data-hero-id="' + id + '"]');
      if (!button) throw new Error('Brak bohatera ' + id);
      button.click();
    }
  })()`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 750))');
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await saveScreenshot('character-selection-three-canonical-heroes');
  await evaluate(`(() => {
    document.querySelector('#character-creation-confirm').click();
  })()`);
  await until('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"',
    'Obóz z trzema bohaterami');
  await evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('#camp-party-heroes img')]
      .map(image => image.decode().catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const view = await evaluate(`(() => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
    };
    const scene = document.querySelector('.camp-scene');
    const stash = scene.querySelector('[data-camp-action="stash"]');
    const stashRect = stash.getBoundingClientRect();
    const middle = { x: stashRect.x + stashRect.width / 2, y: stashRect.y + stashRect.height / 2 };
    const hit = document.elementFromPoint(middle.x, middle.y);
    return {
      viewport:[innerWidth, innerHeight], scene:rect(scene), stash:rect(stash),
      stashHit:hit?.closest('[data-camp-action]')?.dataset.campAction ?? null,
      stashDisabled:stash.disabled,
      heroes:[...scene.querySelectorAll('#camp-party-heroes .camp-party-hero')].map(figure => ({
        rect:rect(figure), name:figure.querySelector('figcaption')?.textContent,
        image:figure.querySelector('img')?.getAttribute('src'),
        imageRect:rect(figure.querySelector('img')),
        loaded:Boolean(figure.querySelector('img')?.naturalWidth),
        pointerEvents:getComputedStyle(figure).pointerEvents,
      })),
      partyIds:window.__rotwDebug.snapshot().save.partyIds,
      music:localStorage.getItem('rotw.music.volume.v1'),
    };
  })()`);
  check(view.viewport[0] === 1920 && view.viewport[1] === 1080, 'Kadr 1920×1080', view.viewport);
  check(view.heroes.length === 3 && view.heroes.every(hero => hero.loaded && hero.rect.width > 0
    && hero.rect.height > 0 && hero.rect.x >= view.scene.x && hero.rect.right <= view.scene.right
    && hero.rect.y >= view.scene.y && hero.rect.bottom <= view.scene.bottom),
  'Trzy oryginalne sylwetki są w całości widoczne w obozie', view.heroes);
  check(view.heroes.every(hero => hero.rect.width >= 150 && hero.rect.width <= 160
    && hero.rect.height >= 165 && hero.rect.height <= 175),
    'Dorośli bohaterowie w mieście mają proporcjonalną skalę przy 1920×1080',
    view.heroes.map(({name,rect}) => ({name,width:rect.width,height:rect.height})));
  const heroBaselines = view.heroes.map(({ rect }) => rect.bottom);
  const visibleHeroBaselines = view.heroes.map(({ imageRect }) => imageRect.bottom);
  const visibleHeroHeights = view.heroes.map(({ imageRect }) => imageRect.height);
  check(Math.max(...heroBaselines) - Math.min(...heroBaselines) <= 1
    && Math.max(...visibleHeroBaselines) - Math.min(...visibleHeroBaselines) <= 1
    && Math.max(...visibleHeroHeights) - Math.min(...visibleHeroHeights) <= 1
    && view.heroes.every(hero => hero.imageRect.bottom < view.scene.y + view.scene.height * 0.315)
    && view.heroes[1].rect.x + view.heroes[1].rect.width / 2 > view.heroes[0].rect.x + view.heroes[0].rect.width / 2
    && view.heroes[2].rect.x + view.heroes[2].rect.width / 2 > view.heroes[1].rect.x + view.heroes[1].rect.width / 2,
  'Trzej bohaterowie stoją po lewej, nad i po prawej od ogniska na równej wysokości',
  view.heroes.map(({name,rect}) => ({name,x:rect.x + rect.width / 2,baseline:rect.bottom})));
  check(view.heroes.every(hero => hero.pointerEvents === 'none') && view.stashHit === 'stash'
    && !view.stashDisabled,
  'Sylwetki nie zakrywają klikalnego hotspotu skrytki', view);
  check(JSON.stringify(view.partyIds) === JSON.stringify(['korgan', 'hadriel', 'ormus']),
    'Obóz pokazuje wybraną trzyosobową drużynę', view.partyIds);
  check(view.music === '0.05', 'Muzyka 5% tylko w profilu testowym', view.music);
  await saveScreenshot('camp-three-canonical-heroes');
  await evaluate('document.querySelector("#camp-open-inventory")?.click()');
  await until('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "false"',
    'Inventory aktywnej postaci');
  const inventoryHero = await evaluate(`(() => {
    const slots = document.querySelector('#equipment-slots');
    return { classId:slots?.dataset.heroClass, image:getComputedStyle(slots, '::before').backgroundImage,
      opacity:Number(getComputedStyle(slots, '::before').opacity),
      selected:window.__rotwDebug.snapshot().save.inspectedCharacterId };
  })()`);
  check(inventoryHero.classId === 'barbarian' && inventoryHero.image.includes('unit-canonical-barbarian-v1.png'),
    'Paper doll inventory pokazuje zaakceptowanego bohatera bez ruszania slotów', inventoryHero);
  check(inventoryHero.opacity > 0 && inventoryHero.opacity <= 0.35,
    'Sylwetka za panelem inventory jest wyraźnie przezroczysta', inventoryHero.opacity);
  await saveScreenshot('inventory-canonical-hero-and-paper-doll');
  await evaluate('document.querySelector("#game-panel .panel-close")?.click()');
  await until('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "true"',
    'Powrót do obozu po podglądzie inventory');
  const capture = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  await writeFile(OUTPUT, Buffer.from(capture.data, 'base64'));
  console.log(`SCREENSHOT ${OUTPUT}`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x:view.stash.x + view.stash.width / 2,
    y:view.stash.y + view.stash.height / 2, button:'left', clickCount:1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x:view.stash.x + view.stash.width / 2,
    y:view.stash.y + view.stash.height / 2, button:'left', clickCount:1 });
  await until('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "false"',
    'Kliknięcie skrytki na scenie');
  check(await evaluate('Boolean(document.querySelector("#panel-body.camp-stash-view"))'),
    'Fizyczny klik w hotspot otwiera skrytkę');
  await evaluate(`(async () => {
    await Promise.all([...document.querySelectorAll('#panel-body.camp-stash-view .d2-stash-item-art img')]
      .map(image => image.decode().catch(() => {})));
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const stashView = await evaluate(`(() => {
    const grids = [...document.querySelectorAll('#panel-body.camp-stash-view .d2-stash-grid, #panel-body.camp-stash-view .d2-backpack-grid')];
    const cards = grids.flatMap(grid => [...grid.querySelectorAll('.loot-row.d2-grid-item')].map(card => {
      const rect = node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
      const art = card.querySelector('.d2-stash-item-art');
      const image = art?.querySelector('img');
      const button = card.querySelector('button.metal-button');
      const name = card.querySelector('.d2-stash-item-name');
      return { label:card.getAttribute('aria-label'), card:rect(card), art:art ? rect(art) : null,
        image:image ? {loaded:Boolean(image.naturalWidth),rect:rect(image)} : null,
        button:button ? rect(button) : null, nameWidth:name?.getBoundingClientRect().width ?? null,
        layout:getComputedStyle(card).display, grid:card.parentElement.classList.contains('d2-stash-grid') ? 'stash' : 'backpack' };
    }));
    return { grids:grids.map(grid => ({className:grid.className,columns:getComputedStyle(grid).gridTemplateColumns,
      overlayPointerEvents:getComputedStyle(grid,'::after').pointerEvents,
      overlayBackground:getComputedStyle(grid,'::after').backgroundImage,
      cellCount:grid.querySelectorAll('.d2-grid-cell').length})), cards };
  })()`);
  const packCards = stashView.cards.filter(card => card.grid === 'backpack');
  check(packCards.length > 0, 'Skrytka wyświetla przedmioty aktywnej postaci w plecaku', packCards);
  check(packCards.every(card => card.layout === 'block' && card.art && card.button
    && card.button.width <= 20 && card.button.height <= 20
    && card.art.bottom < card.button.y
    && card.nameWidth <= 1 && card.button.x >= card.card.x && card.button.right <= card.card.right
    && card.button.bottom <= card.card.bottom),
  'Ikona, nazwa dostępności i mały przycisk transferu nie nachodzą na siebie', packCards);
  check(packCards.every(card => card.image?.loaded),
    'Widoczne ikony wyposażenia w plecaku załadowały się poprawnie', packCards);
  check(stashView.grids.every(grid => grid.overlayPointerEvents === 'none'),
    'Linie siatki nadal nie blokują klikania przedmiotów', stashView.grids);
  check(stashView.grids.find(grid => grid.className.includes('d2-stash-grid'))?.cellCount === 80
    && stashView.grids.find(grid => grid.className.includes('d2-stash-grid'))?.overlayBackground === 'none',
  'Skrytka rysuje tylko 10 × 8 prawdziwych pól bez fałszywych podziałów', stashView.grids);
  const stashCapture = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  await writeFile(STASH_OUTPUT, Buffer.from(stashCapture.data, 'base64'));
  console.log(`SCREENSHOT ${STASH_OUTPUT}`);
  const beforeTransfer = stashView.cards.reduce((counts, card) => {
    counts[card.grid] += 1;
    return counts;
  }, { stash:0, backpack:0 });
  await evaluate('document.querySelector("#panel-body.camp-stash-view .d2-stash-backpack-wing button.metal-button")?.click()');
  await until(`document.querySelectorAll('#panel-body.camp-stash-view .d2-stash-grid .loot-row.d2-grid-item').length === ${beforeTransfer.stash + 1}`,
    'Przeniesienie przedmiotu z plecaka do skrytki');
  const afterTransfer = await evaluate(`({
    stash:document.querySelectorAll('#panel-body.camp-stash-view .d2-stash-grid .loot-row.d2-grid-item').length,
    backpack:document.querySelectorAll('#panel-body.camp-stash-view .d2-backpack-grid .loot-row.d2-grid-item').length,
  })`);
  check(afterTransfer.stash === beforeTransfer.stash + 1
    && afterTransfer.backpack === beforeTransfer.backpack - 1,
  'Przycisk transferu nadal przenosi przedmiot do skrytki bez utraty', {beforeTransfer,afterTransfer});
  await evaluate('document.querySelector("#panel-body.camp-stash-view .d2-stash-grid button.metal-button")?.click()');
  await until(`document.querySelectorAll('#panel-body.camp-stash-view .d2-stash-grid .loot-row.d2-grid-item').length === ${beforeTransfer.stash}`,
    'Przeniesienie przedmiotu ze skrytki do plecaka');
  const returnedTransfer = await evaluate(`({
    stash:document.querySelectorAll('#panel-body.camp-stash-view .d2-stash-grid .loot-row.d2-grid-item').length,
    backpack:document.querySelectorAll('#panel-body.camp-stash-view .d2-backpack-grid .loot-row.d2-grid-item').length,
  })`);
  check(returnedTransfer.stash === beforeTransfer.stash
    && returnedTransfer.backpack === beforeTransfer.backpack,
  'Przycisk odbioru ze skrytki odtwarza poprzedni stan plecaka', returnedTransfer);

  await send('Page.navigate', { url: `${APP_URL}?training=1&skip-team-selection=1` });
  await until('Boolean(window.__rotwDebug?.snapshot) && document.querySelector("#main-menu")?.hidden',
    'Walka testowa z tym samym kanonicznym trio');
  await until('document.querySelector(".battle-state")?.dataset.battlePhase === "preparation"',
    'Przygotowanie do walki');
  const battleSetup = await evaluate(`(() => ({
    ids:window.__rotwDebug.snapshot().save.partyIds,
    paths:[...document.querySelectorAll('#party .hero')].map(node => ({
      id:node.dataset.characterId, image:node.querySelector('img')?.getAttribute('src'),
    })),
  }))()`);
  check(JSON.stringify(battleSetup.ids) === JSON.stringify(['korgan', 'hadriel', 'ormus']),
    'Walka zachowuje wybrane klasy i identyfikatory trio', battleSetup);
  check(battleSetup.paths.every(({ id, image }) => image?.includes(`unit-canonical-${({
    korgan:'barbarian', hadriel:'paladin', ormus:'necromancer',
  })[id]}-portrait-v1.png`)), 'Karty HUD używają portretów z kanonicznego arkusza', battleSetup.paths);
  await evaluate('document.querySelector("#start-battle").click()');
  await until('document.querySelector(".battle-state")?.dataset.battlePhase === "active"',
    'Walka z kanonicznym trio');
  await evaluate(`(async () => {
    await Promise.all([...document.querySelectorAll('#party .hero img, #active-portrait')]
      .map(image => image.decode().catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const activePath = await evaluate('document.querySelector("#active-portrait")?.getAttribute("src")');
  check(activePath?.includes('unit-canonical-barbarian-portrait-v1.png'),
    'Portret aktywnego bohatera korzysta z tego samego wzorca', activePath);
  await saveScreenshot('battle-three-canonical-heroes-and-hud');
  check(errors.length === 0, 'Brak błędów JavaScript', errors);
}

try { await main(); }
finally {
  socket?.close();
  if (browser) {
    const result = await cleanupTrackedBrowser(browser);
    console.log(`CLEANUP own browser: ${result.remaining?.length ?? 0} remaining processes`);
  }
}
