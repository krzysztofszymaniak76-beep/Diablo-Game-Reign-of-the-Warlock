const HISTORY_URL = '/app/release-history.json';
const UPDATE_URL = '/__rotw_update';

function validRelease(value) {
  return value && typeof value.version === 'string' && /^\d+(?:\.\d+)*$/.test(value.version)
    && typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && Array.isArray(value.changes) && value.changes.length > 0
    && value.changes.every(change => typeof change === 'string' && change.trim());
}

function formatDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat('pl-PL', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(parsed);
}

export function createMenuUpdates({ root, content, fetcher = fetch }) {
  const corner = root.querySelector('.main-menu-release-corner');
  const opener = root.querySelector('#menu-release-open');
  const versionOutput = root.querySelector('#menu-current-version');
  const dialog = root.querySelector('#menu-release-dialog');
  const closeButton = root.querySelector('#menu-release-close');
  const status = root.querySelector('#menu-release-status');
  const list = root.querySelector('#menu-release-list');
  const checkButton = root.querySelector('#menu-release-check');
  const installButton = root.querySelector('#menu-release-install');

  let currentVersion = versionOutput.textContent.trim();
  let releases = [];
  let remoteRelease = null;
  let historyLoaded = false;
  let historyPromise = null;
  let checking = false;
  let installing = false;
  let installStarted = false;
  let blocked = false;

  function renderHistory() {
    const all = [...releases];
    if (validRelease(remoteRelease) && !all.some(item => item.version === remoteRelease.version)) {
      all.push(remoteRelease);
    }
    all.sort((a, b) => b.version.localeCompare(a.version, 'pl', { numeric: true }) || b.date.localeCompare(a.date));
    list.replaceChildren();
    if (all.length === 0) {
      const message = document.createElement('p');
      message.textContent = 'Historia wydań jest chwilowo niedostępna.';
      list.append(message);
      return;
    }
    for (const release of all) {
      const entry = document.createElement('article');
      entry.className = 'main-menu-release-entry';
      const title = document.createElement('h3');
      title.textContent = `Wersja ${release.version}`;
      const date = document.createElement('time');
      date.dateTime = release.date;
      date.textContent = release.status === 'prepared'
        ? `Przygotowano ${formatDate(release.date)}` : formatDate(release.date);
      const changes = document.createElement('ul');
      for (const change of release.changes) {
        const item = document.createElement('li');
        item.textContent = change;
        changes.append(item);
      }
      entry.append(title, date, changes);
      list.append(entry);
    }
  }

  function loadHistory() {
    if (historyLoaded) return Promise.resolve();
    if (historyPromise) return historyPromise;
    historyPromise = (async () => {
      const response = await fetcher(HISTORY_URL, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Historia wydań jest chwilowo niedostępna.');
      const history = await response.json();
      if (!history || typeof history.currentVersion !== 'string'
        || !/^\d+(?:\.\d+)*$/.test(history.currentVersion)
        || !Array.isArray(history.releases) || !history.releases.every(validRelease)) {
        throw new Error('Historia wydań ma nieprawidłowy format.');
      }
      currentVersion = history.currentVersion;
      versionOutput.textContent = currentVersion;
      releases = history.releases;
      historyLoaded = true;
      renderHistory();
    })().catch(() => {
      renderHistory();
    }).finally(() => { historyPromise = null; });
    return historyPromise;
  }

  async function checkUpdates() {
    if (checking || installing || installStarted) return;
    checking = true;
    checkButton.disabled = true;
    installButton.hidden = true;
    remoteRelease = null;
    status.textContent = 'Sprawdzanie aktualizacji…';
    try {
      const response = await fetcher(UPDATE_URL, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok && !response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Instalator aktualizacji nie jest jeszcze dostępny.');
      }
      const result = await response.json();
      if (!response.ok) throw new Error('Nie można teraz sprawdzić dostępności aktualizacji. Instalator jest niedostępny.');
      if (result?.error) throw new Error(result.error);
      if (typeof result.currentVersion === 'string' && /^\d+(?:\.\d+)*$/.test(result.currentVersion)) {
        currentVersion = result.currentVersion;
        versionOutput.textContent = currentVersion;
      }
      if (result.updateAvailable === true && typeof result.latestVersion === 'string'
        && /^\d+(?:\.\d+)*$/.test(result.latestVersion)
        && result.latestVersion !== currentVersion) {
        remoteRelease = validRelease(result.release) ? result.release : null;
        installButton.textContent = `Zainstaluj wersję ${result.latestVersion}`;
        installButton.hidden = false;
        installButton.disabled = root.dataset.context === 'game';
        status.textContent = root.dataset.context === 'game'
          ? `Dostępna jest wersja ${result.latestVersion}. Najpierw Zapisz i wyjdź do ekranu startowego.`
          : `Dostępna jest wersja ${result.latestVersion}.`;
      } else {
        installButton.disabled = false;
        status.textContent = 'Brak dostępnego instalatora aktualizacji.';
      }
      renderHistory();
    } catch (error) {
      status.textContent = error instanceof TypeError || error instanceof SyntaxError
        ? 'Nie można teraz sprawdzić dostępności aktualizacji. Instalator jest niedostępny.'
        : error.message || 'Nie udało się sprawdzić aktualizacji.';
    } finally {
      checking = false;
      checkButton.disabled = false;
    }
  }

  async function installUpdate() {
    if (installButton.hidden || installing || installStarted) return;
    if (root.dataset.context === 'game') {
      status.textContent = 'Najpierw Zapisz i wyjdź do ekranu startowego.';
      return;
    }
    installing = true;
    checkButton.disabled = true;
    installButton.disabled = true;
    status.textContent = 'Uruchamianie instalatora aktualizacji…';
    try {
      const response = await fetcher(UPDATE_URL, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install' }),
      });
      if (!response.ok && !response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Nie udało się uruchomić instalatora.');
      }
      const result = await response.json();
      if (!response.ok || result?.started !== true) {
        throw new Error(result?.error || 'Nie udało się uruchomić instalatora.');
      }
      installStarted = true;
      status.textContent = 'Instalator został uruchomiony. Po zakończeniu instalacji uruchom grę ponownie.';
    } catch (error) {
      status.textContent = error.message || 'Nie udało się uruchomić instalatora.';
    } finally {
      installing = false;
      checkButton.disabled = installStarted;
      installButton.disabled = installStarted;
    }
  }

  function open() {
    if (!dialog.hidden || blocked || content.inert) return;
    content.inert = true;
    content.setAttribute('aria-hidden', 'true');
    corner.inert = true;
    dialog.hidden = false;
    closeButton.focus({ preventScroll: true });
    renderHistory();
    void loadHistory();
    void checkUpdates();
  }

  function close({ restoreFocus = true } = {}) {
    if (dialog.hidden) return;
    dialog.hidden = true;
    content.inert = false;
    content.removeAttribute('aria-hidden');
    corner.inert = blocked;
    if (restoreFocus && !root.hidden) opener.focus({ preventScroll: true });
  }

  function setBlocked(value) {
    blocked = value;
    if (blocked) close({ restoreFocus: false });
    corner.inert = blocked;
  }

  opener.addEventListener('click', open);
  closeButton.addEventListener('click', () => close());
  checkButton.addEventListener('click', () => { void checkUpdates(); });
  installButton.addEventListener('click', () => { void installUpdate(); });
  void loadHistory();

  return { dialog, close, setBlocked, isOpen: () => !dialog.hidden };
}
