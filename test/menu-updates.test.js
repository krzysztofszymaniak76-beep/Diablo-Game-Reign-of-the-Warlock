import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMenuUpdates } from '../app/menu-updates.js';

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.inert = false;
    this.textContent = '';
    this.attributes = new Map();
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  focus() { globalThis.__focusedMenuElement = this; }
  click() { this.listeners.get('click')?.(); }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('historia 0.1 i instalacja tylko po potwierdzeniu aktualizacji', async () => {
  const history = JSON.parse(await readFile(new URL('../app/release-history.json', import.meta.url), 'utf8'));
  const selectors = [
    '.main-menu-release-corner', '#menu-release-open', '#menu-current-version',
    '#menu-release-dialog', '#menu-release-close', '#menu-release-status',
    '#menu-release-list', '#menu-release-check', '#menu-release-install',
  ];
  const elements = new Map(selectors.map(selector => [selector, new Element()]));
  const root = new Element();
  root.dataset = { context: 'title' };
  root.querySelector = selector => elements.get(selector);
  const content = new Element();
  const dialog = elements.get('#menu-release-dialog');
  const opener = elements.get('#menu-release-open');
  const list = elements.get('#menu-release-list');
  const status = elements.get('#menu-release-status');
  const install = elements.get('#menu-release-install');
  const version = elements.get('#menu-current-version');
  dialog.hidden = true;
  install.hidden = true;
  version.textContent = '0.1';

  let update = { currentVersion: '0.1', latestVersion: '0.1', updateAvailable: false };
  const posts = [];
  const fetcher = async (url, options = {}) => {
    if (url === '/app/release-history.json') return Response.json(history);
    assert.equal(url, '/__rotw_update');
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return Response.json({ started: true });
    }
    if (update.fail) return Response.json({ error: 'fetch failed' }, { status: 503 });
    return Response.json(update);
  };

  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  try {
    const ui = createMenuUpdates({ root, content, fetcher });
    await tick();
    assert.equal(version.textContent, '0.1');
    opener.click();
    await tick();
    assert.equal(dialog.hidden, false);
    assert.equal(content.inert, true);
    assert.equal(install.hidden, true);
    assert.match(status.textContent, /Brak dostępnego instalatora/);
    assert.equal(list.children[0].children[0].textContent, 'Wersja 0.1');
    assert.match(list.children[0].children[1].textContent, /Przygotowano .*2026/);
    assert.equal(list.children[0].children[2].children.length, history.releases[0].changes.length);
    install.click();
    await tick();
    assert.equal(posts.length, 0);

    ui.close();
    assert.equal(dialog.hidden, true);
    assert.equal(content.inert, false);
    assert.equal(globalThis.__focusedMenuElement, opener);

    ui.setBlocked(true);
    opener.click();
    assert.equal(dialog.hidden, true);
    assert.equal(elements.get('.main-menu-release-corner').inert, true);
    ui.setBlocked(false);

    update = { fail: true };
    opener.click();
    await tick();
    assert.match(status.textContent, /Nie można teraz sprawdzić dostępności aktualizacji/);
    assert.equal(install.hidden, true);
    ui.close();

    update = {
      currentVersion: '0.1', latestVersion: '0.2', updateAvailable: true,
      release: { version: '0.2', date: '2026-10-01', changes: ['Potwierdzona poprawka testowa.'] },
    };
    root.dataset.context = 'game';
    opener.click();
    await tick();
    assert.equal(install.hidden, false);
    assert.equal(install.disabled, true);
    assert.match(status.textContent, /Najpierw Zapisz i wyjdź/);
    assert.equal(list.children[0].children[0].textContent, 'Wersja 0.2');
    assert.equal(list.children[1].children[0].textContent, 'Wersja 0.1');
    install.click();
    await tick();
    assert.equal(posts.length, 0);
    ui.close();

    root.dataset.context = 'title';
    opener.click();
    await tick();
    assert.equal(install.disabled, false);
    install.click();
    await tick();
    assert.deepEqual(posts, [{ action: 'install' }]);
    assert.match(status.textContent, /Instalator został uruchomiony/);
    install.click();
    await tick();
    assert.equal(posts.length, 1);
  } finally {
    globalThis.document = oldDocument;
    delete globalThis.__focusedMenuElement;
  }
});
