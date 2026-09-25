// Headless interaction checks for the real camp trade UI. All save mutations
// happen inside a disposable browser profile, never the player's profile.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUT = path.resolve('docs/evidence/trade-vendors/trade-interactions.json');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
const errors = [];
const passed = [];
let browser;
let socket;
let sequence = 0;
installGlobalCleanupHandlers();

function check(condition, label, details) {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(details)}`);
  passed.push(label);
  console.log(`PASS ${label}`);
}

function send(method, params = {}) {
  const id = ++sequence;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return answer;
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function until(expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await wait(80);
  }
  throw new Error(`Timeout: ${label}`);
}

const state = () => evaluate(`(() => {
  const save = window.__rotwDebug.snapshot().save;
  const bag = save.inventories.find(([id]) => id === 'korgan')?.[1];
  return {
    gold:save.campServices.gold,
    bag:bag?.items.map(item => ({ id:item.id, canonicalId:item.canonicalId,
      durability:item.durability, maxDurability:item.maxDurability })) ?? [],
    vendors:Object.fromEntries(save.campServices.vendors.map(vendor =>
      [vendor.id, vendor.offers.map(offer => ({ offerId:offer.offerId,
        itemId:offer.item.id, canonicalId:offer.item.canonicalId, price:offer.buyPrice }))])),
    hero:save.roster.find(hero => hero.id === 'korgan')?.resources,
  };
})()`);

async function openVendor(id) {
  await evaluate(`document.querySelector('[data-camp-action=${JSON.stringify(id)}]').click()`);
  await until(`document.querySelector('#merchant-panel')?.getAttribute('aria-label')
    ?.toLowerCase().includes(${JSON.stringify(id)})`, `sklep ${id}`);
}

async function closeVendor() {
  await evaluate('document.querySelector("#close-panel").click()');
  await until('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "true"',
    'zamknięcie handlu');
}

// Loads a deliberately altered save only in the browser's temporary profile.
async function isolatedFixture(mutateSource) {
  return evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    ${mutateSource}
    localStorage.setItem(window.__rotwDebug.storageKeys.current, JSON.stringify(save));
    return window.__rotwDebug.loadGameState();
  })()`);
}

async function main() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), {
    signal: AbortSignal.timeout(5000),
  })).json();
  check(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    'serwer wskazuje bieżący projekt', health);
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
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('rotw.music.volume.v1', '0.05'); } catch {}",
  });
  await send('Page.navigate', { url: APP_URL });
  await until('Boolean(window.__rotwDebug?.snapshot) && !document.querySelector("#main-menu").hidden',
    'menu startowe');
  await evaluate('document.querySelector("#menu-new-game").click()');
  await until('document.querySelector("#character-creation")?.getAttribute("aria-hidden") === "false"',
    'wybór postaci');
  await evaluate(`(() => {
    document.querySelector('.character-creation-class[data-hero-id="korgan"]').click();
    document.querySelector('#character-creation-confirm').click();
  })()`);
  await until('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"',
    'wejście do obozu');
  check(await evaluate("localStorage.getItem('rotw.music.volume.v1') === '0.05'"),
    'dźwięk 5% wyłącznie w profilu testowym');

  await openVendor('charsi');
  const first = await state();
  check(first.vendors.charsi.length > 0, 'Charsi ma prawdziwe oferty', first.vendors.charsi);
  await closeVendor();
  await openVendor('charsi');
  const reopened = await state();
  check(JSON.stringify(reopened.vendors.charsi) === JSON.stringify(first.vendors.charsi),
    'ponowne otwarcie Charsi nie losuje towaru');

  const offer = [...first.vendors.charsi]
    .filter(entry => entry.price <= first.gold)
    .sort((a, b) => a.price - b.price)[0];
  check(Boolean(offer), 'jest towar możliwy do kupienia za obecne złoto');
  await evaluate(`document.querySelector('[data-offer-id=${JSON.stringify(offer.offerId)}]').click()`);
  const bought = await state();
  check(bought.gold === first.gold - offer.price
    && bought.bag.some(item => item.id === offer.itemId)
    && !bought.vendors.charsi.some(entry => entry.offerId === offer.offerId),
  'zakup przenosi przedmiot do plecaka, pobiera cenę i usuwa ofertę',
  { before:first.gold, after:bought.gold, offer });

  await evaluate(`document.querySelector('#inventory-grid [data-item-id=${JSON.stringify(offer.itemId)}]').click()`);
  const sellQuote = await evaluate(`Number(document.querySelector('.merchant-sell')
    ?.textContent.match(/\\d+/)?.[0])`);
  check(Number.isInteger(sellQuote) && sellQuote > 0, 'sprzedaż pokazuje rzeczywistą cenę', sellQuote);
  await evaluate('document.querySelector(".merchant-sell").click()');
  const sold = await state();
  check(sold.gold === bought.gold + sellQuote
    && !sold.bag.some(item => item.id === offer.itemId)
    && sold.vendors.charsi.filter(entry => entry.itemId === offer.itemId).length === 1,
  'sprzedaż oddaje złoto i przenosi dokładnie jeden egzemplarz do sklepu',
  { before:bought.gold, after:sold.gold, quote:sellQuote });

  check(await evaluate('window.__rotwDebug.saveGameState()'), 'zapis po handlu');
  check(await evaluate('window.__rotwDebug.loadGameState()'), 'wczytanie rozpoczyna nową sesję');
  const nextSession = await state();
  check(nextSession.gold === sold.gold
    && JSON.stringify(nextSession.bag) === JSON.stringify(sold.bag)
    && nextSession.vendors.charsi.every(entry =>
      !sold.vendors.charsi.some(old => old.offerId === entry.offerId)),
  'nowa sesja zmienia oferty bez utraty złota lub plecaka');

  check(await isolatedFixture(`const hero = save.roster.find(entry => entry.id === 'korgan');
    hero.resources.hp = Math.max(1, hero.resources.maxHp - 9);
    hero.resources.mana = Math.max(0, hero.resources.maxMana - 3);`),
  'izolowany zapis testowy uszkodzonych zasobów jest poprawny');
  const wounded = await state();
  check(wounded.hero.hp < wounded.hero.maxHp && wounded.hero.mana < wounded.hero.maxMana,
    'postać w profilu testowym potrzebuje leczenia', wounded.hero);
  await evaluate('document.querySelector("[data-camp-action=akara]").click()');
  await until(`document.querySelector('#merchant-panel')?.getAttribute('aria-label')
    ?.toLowerCase().includes('akara')`, 'bezpośredni sklep Akary');
  const healed = await state();
  check(healed.hero.hp === healed.hero.maxHp && healed.hero.mana === healed.hero.maxMana,
    'kliknięcie Akary odnawia życie i manę bez osobnego przycisku',
    { before:wounded.hero, after:healed.hero });
  await evaluate('document.querySelector("#close-panel").click()');

  const repairCandidate = healed.bag.find(item => item.maxDurability > 1);
  check(Boolean(repairCandidate), 'w plecaku jest prawdziwy przedmiot do próby naprawy');
  check(await isolatedFixture(`const bag = save.inventories.find(([id]) => id === 'korgan')[1];
    const item = bag.items.find(entry => entry.id === ${JSON.stringify(repairCandidate.id)});
    item.durability = Math.max(1, item.maxDurability - 3);`),
  'izolowany zapis z uszkodzonym przedmiotem jest poprawny');
  const damaged = await state();
  check(damaged.bag.find(item => item.id === repairCandidate.id)?.durability
    < repairCandidate.maxDurability, 'przedmiot w profilu testowym jest uszkodzony');
  await openVendor('charsi');
  await evaluate(`document.querySelector('#inventory-grid [data-item-id=${JSON.stringify(repairCandidate.id)}]').click()`);
  await evaluate('document.querySelector("#charsi-repair").click()');
  const quoteText = await evaluate('document.querySelector(".merchant-empty-status").textContent');
  check(/kosztuje \d+ złota/.test(quoteText), 'młotek pokazuje koszt i wymaga potwierdzenia', quoteText);
  await evaluate('document.querySelector("#charsi-repair").click()');
  const repaired = await state();
  const repairedItem = repaired.bag.find(item => item.id === repairCandidate.id);
  check(repairedItem?.durability === repairedItem?.maxDurability
    && repaired.gold < damaged.gold,
  'naprawa przywraca trwałość tego samego przedmiotu i pobiera złoto',
  { before:damaged.gold, after:repaired.gold, item:repairedItem });
  check(errors.length === 0, 'brak błędów JavaScript', errors);

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    passed, offer:offer.canonicalId, buyPrice:offer.price,
    sellPrice:sellQuote, repairCost:damaged.gold - repaired.gold,
    previousOffers:first.vendors.charsi.length,
    newSessionOffers:nextSession.vendors.charsi.length,
    profile:'disposable', audio:'5%', errors,
  }, null, 2));
  console.log(`EVIDENCE ${OUT}`);
}

try { await main(); }
finally {
  socket?.close();
  if (browser) {
    const result = await cleanupTrackedBrowser(browser);
    console.log(`CLEANUP own browser: ${result.remaining?.length ?? 0} remaining processes`);
  }
}
