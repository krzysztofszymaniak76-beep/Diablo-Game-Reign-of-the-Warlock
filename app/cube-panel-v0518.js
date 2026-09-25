import { attachItemTooltip } from './item-tooltip-v0518.js';

// The panel displays live InventoryGrid snapshots. Ownership changes only in
// callbacks supplied by the game; removing this DOM never moves an item.
const polishName = item => typeof item?.name === 'string' && item.name.trim() ? item.name : 'Przedmiot';
const qualityClass = item => ['normal', 'magic', 'rare', 'unique', 'set'].includes(item?.quality)
  ? item.quality : 'normal';

function node(tag, className = '', label = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label) element.textContent = label;
  return element;
}

function gridSnapshot(grid, width, height, label) {
  if (!grid || typeof grid.toJSON !== 'function') throw new TypeError(`${label}: brak siatki przedmiotów`);
  const snapshot = grid.toJSON();
  if (snapshot.width !== width || snapshot.height !== height || !Array.isArray(snapshot.items)) {
    throw new Error(`${label}: nieprawidłowy rozmiar siatki`);
  }
  return snapshot;
}

function runAction(callback, itemId, button, status) {
  if (typeof callback !== 'function') return;
  button.disabled = true;
  Promise.resolve()
    .then(() => callback({ itemId }))
    .catch(() => { status.textContent = 'Nie udało się przenieść przedmiotu. Sprawdź wolne miejsce.'; })
    .finally(() => { if (button.isConnected) button.disabled = false; });
}

function makeGrid({ snapshot, className, destination, onMove, status, catalog, resolveValue }) {
  const grid = node('div', `cube-item-grid ${className}`);
  grid.style.setProperty('--columns', String(snapshot.width));
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', snapshot.width === 4 ? 'Wnętrze Kostki Horadrimów' : 'Plecak bohatera');
  for (let y = 0; y < snapshot.height; y += 1) {
    for (let x = 0; x < snapshot.width; x += 1) {
      const cell = node('span', 'cube-grid-cell');
      cell.setAttribute('aria-hidden', 'true');
      cell.style.gridColumn = String(x + 1);
      cell.style.gridRow = String(y + 1);
      grid.append(cell);
    }
  }
  for (const item of snapshot.items) {
    const name = polishName(item);
    const button = node('button', `cube-grid-item cube-quality-${qualityClass(item)}`);
    button.type = 'button';
    button.dataset.itemId = item.id;
    button.style.gridColumn = `${item.position.x + 1} / span ${item.width}`;
    button.style.gridRow = `${item.position.y + 1} / span ${item.height}`;
    button.setAttribute('aria-label', `${name}. Przenieś do ${destination}`);
    button.title = `${name} — przenieś do ${destination}`;
    const definition = catalog?.get?.(item.canonicalId) ?? null;
    const value = typeof resolveValue === 'function' ? resolveValue(item) : undefined;
    button.removeAttribute('title');
    attachItemTooltip(button, { item, definition, ...(Number.isFinite(value) ? { value, valueLabel: 'Wartość u handlarza' } : {}) });
    button.disabled = typeof onMove !== 'function';
    button.append(node('span', 'cube-item-name', name));
    button.addEventListener('click', () => runAction(onMove, item.id, button, status));
    grid.append(button);
  }
  return grid;
}

/**
 * onToCube/onFromCube receive { itemId }. They commit through the game model
 * and redraw this panel after success. canTransmute is false until the game
 * supplies a known, validated recipe and an onTransmute callback.
 */
export function renderCubePanel({
  host, cube, inventory, owner, catalog, resolveValue, onToCube, onFromCube, onTransmute, canTransmute = false,
} = {}) {
  if (!host || typeof host.replaceChildren !== 'function') throw new TypeError('Brak miejsca na okno Kostki');
  const cubeData = gridSnapshot(cube?.grid, 4, 3, 'Kostka Horadrimów');
  const bagData = gridSnapshot(inventory, 10, 4, 'Plecak');
  const ownerName = typeof owner?.name === 'string' && owner.name.trim() ? owner.name : 'Bohater';

  const panel = node('div', 'horadric-cube-panel');
  const heading = node('div', 'cube-panel-heading');
  heading.append(node('span', 'cube-panel-sigil', '✧'));
  const headingCopy = node('div');
  headingCopy.append(node('small', '', 'STAROŻYTNY ARTEFAKT'), node('h3', '', 'Kostka Horadrimów'));
  heading.append(headingCopy);
  panel.append(heading);

  const status = node('p', 'cube-panel-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const columns = node('div', 'cube-panel-columns');

  const cubeSide = node('section', 'cube-panel-section cube-panel-relic');
  cubeSide.append(node('h4', '', 'KOSTKA · 4 × 3'));
  cubeSide.append(makeGrid({ snapshot: cubeData, className: 'cube-relic-grid', destination: 'plecaka', onMove: onFromCube, status, catalog, resolveValue }));
  const controls = node('div', 'cube-panel-controls');
  const transmute = node('button', 'cube-transmute-button', 'TRANSMUTUJ');
  transmute.type = 'button';
  transmute.disabled = !(canTransmute && typeof onTransmute === 'function');
  transmute.title = transmute.disabled ? 'Brak znanej receptury dla obecnej zawartości Kostki' : 'Wykonaj znaną recepturę';
  if (!transmute.disabled) {
    transmute.addEventListener('click', () => {
      transmute.disabled = true;
      Promise.resolve().then(() => onTransmute())
        .catch(() => { status.textContent = 'Transmutacja nie powiodła się.'; })
        .finally(() => { if (transmute.isConnected) transmute.disabled = false; });
    });
  }
  controls.append(transmute);
  cubeSide.append(controls);

  const bagSide = node('section', 'cube-panel-section cube-panel-backpack');
  bagSide.append(node('h4', '', `PLECAK · ${ownerName}`));
  bagSide.append(makeGrid({ snapshot: bagData, className: 'cube-backpack-grid', destination: 'Kostki', onMove: onToCube, status, catalog, resolveValue }));
  bagSide.append(node('p', 'cube-panel-hint', 'Kliknij przedmiot, aby przenieść go do drugiej siatki.'));

  columns.append(cubeSide, bagSide);
  panel.append(columns, status);
  host.classList.add('cube-panel-view');
  host.replaceChildren(panel);
  return panel;
}
