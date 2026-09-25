const SAVE_URL = '/__rotw_save';

export function createSaveBridge(fetcher = fetch) {
  let pending = Promise.resolve();
  let lastError = null;

  async function read() {
    const response = await fetcher(SAVE_URL, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Dyskowy zapis gry jest niedostępny (${response.status})`);
    const body = await response.json();
    if (!body || !['string', 'object'].includes(typeof body.primary)
      || !['string', 'object'].includes(typeof body.backup)
      || (body.primary !== null && typeof body.primary !== 'string')
      || (body.backup !== null && typeof body.backup !== 'string')) {
      throw new Error('Nieprawidłowa odpowiedź magazynu zapisu');
    }
    return body;
  }

  function write(raw, options = {}) {
    pending = pending.catch(() => {}).then(async () => {
      const response = await fetcher(SAVE_URL, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, ...options }),
      });
      const result = await response.json();
      if (!response.ok || result.saved !== true) {
        throw new Error(result.error ?? `Nie udało się zapisać pliku (${response.status})`);
      }
      lastError = null;
      return true;
    }).catch((error) => {
      lastError = error;
      throw error;
    });
    // Callers may keep the synchronous save API; flush() observes failures.
    pending.catch(() => {});
    return pending;
  }

  async function flush() {
    await pending;
    if (lastError) throw lastError;
    return true;
  }

  return { read, write, flush, error: () => lastError };
}
