import { requirementsFor } from '../src/core/equipment.js';

const QUALITY = Object.freeze({
  normal: ['Zwykły', 'normal'],
  magic: ['Magiczny', 'magic'],
  rare: ['Rzadki', 'rare'],
  unique: ['Unikatowy', 'unique'],
  set: ['Zestawowy', 'set'],
  crafted: ['Wykonany', 'crafted'],
  superior: ['Wyjątkowy', 'superior'],
});

const TYPE_NAMES = Object.freeze({
  axe: 'Topór', swor: 'Miecz', knif: 'Sztylet', hamm: 'Młot', mace: 'Buława', taxe: 'Topór do rzucania',
  spea: 'Włócznia', staf: 'Kostur', wand: 'Różdżka', bow: 'Łuk', xbow: 'Kusza', h2h: 'Katar',
  scep: 'Berło', club: 'Maczuga',
});

let tooltipNode;
let hideTimer = 0;

export function hideItemTooltip() {
  clearTimeout(hideTimer);
  if (tooltipNode) {
    tooltipNode.hidden = true;
    tooltipNode.className = 'rotw-item-tooltip';
  }
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = String(text);
  return node;
}

function tooltip() {
  if (tooltipNode?.isConnected) return tooltipNode;
  tooltipNode = document.createElement('aside');
  tooltipNode.className = 'rotw-item-tooltip';
  tooltipNode.id = 'rotw-item-tooltip';
  tooltipNode.setAttribute('role', 'tooltip');
  tooltipNode.hidden = true;
  document.body.append(tooltipNode);
  return tooltipNode;
}

export function unmetItemRequirementCopy(definition, character) {
  if (!definition || !character) return '';
  const problems = requirementsFor(character, definition);
  return problems.length ? `Nie możesz teraz założyć: ${problems.join(' · ')}` : '';
}

function buildTooltip(node, { item, definition, character, value, valueLabel = 'Wartość u handlarza' }) {
  const quality = QUALITY[item.quality] ?? QUALITY.normal;
  node.replaceChildren();
  node.className = `rotw-item-tooltip is-visible quality-${quality[1]}`;
  const copy = document.createElement('div');
  copy.className = 'rotw-item-tooltip-copy';
  copy.append(textNode('h3', 'rotw-item-tooltip-name', item.identified === false ? 'Niezidentyfikowany przedmiot' : item.name));
  copy.append(textNode('p', 'rotw-item-tooltip-quality', quality[0]));
  if (definition) {
    copy.append(textNode('p', 'rotw-item-tooltip-type', TYPE_NAMES[definition.type] ?? definition.type ?? 'Przedmiot'));
    if (definition.kind === 'weapon') {
      if (definition.throwDamage) copy.append(textNode('p', 'rotw-item-tooltip-row', `Obrażenia przy rzucie: ${definition.throwDamage.join('–')}`));
      else if (definition.twoHanded) copy.append(textNode('p', 'rotw-item-tooltip-row', `Obrażenia: ${definition.twoHandDamage.join('–')} (oburącz)`));
      else copy.append(textNode('p', 'rotw-item-tooltip-row', `Obrażenia: ${definition.oneHandDamage.join('–')} (jedną ręką)`));
    } else if (definition.defenseRange?.[1]) {
      copy.append(textNode('p', 'rotw-item-tooltip-row', `Obrona: ${item.defense} (baza ${definition.defenseRange.join('–')})`));
    }
    const required = [];
    if (definition.requiredLevel) required.push(`Poziom ${definition.requiredLevel}`);
    if (definition.requiredStrength) required.push(`Siła ${definition.requiredStrength}`);
    if (definition.requiredDexterity) required.push(`Zręczność ${definition.requiredDexterity}`);
    if (definition.classOnly) required.push(`Klasa: ${({ assassin: 'Zabójczyni', paladin: 'Paladyn' }[definition.classOnly] ?? definition.classOnly)}`);
    copy.append(textNode('p', 'rotw-item-tooltip-row', required.length ? `Wymagania: ${required.join(' · ')}` : 'Wymagania: brak'));
    const unmetRequirements = unmetItemRequirementCopy(definition, character);
    if (unmetRequirements) copy.append(textNode('p', 'rotw-item-tooltip-requirement-error', unmetRequirements));
    if (item.maxDurability > 0) copy.append(textNode('p', 'rotw-item-tooltip-row', `Trwałość: ${item.durability}/${item.maxDurability}`));
    if (definition.stackable) copy.append(textNode('p', 'rotw-item-tooltip-row', `Ilość: ${item.quantity}/${item.maxQuantity}`));
    if (Array.isArray(item.sockets) && item.sockets.length) copy.append(textNode('p', 'rotw-item-tooltip-row', `Gniazda: ${item.sockets.length}`));
  }
  const properties = Array.isArray(item.properties) ? item.properties : [];
  for (const property of properties) {
    const line = typeof property === 'string' ? property : property?.text;
    if (typeof line === 'string' && line.trim()) copy.append(textNode('p', 'rotw-item-tooltip-property', line));
  }
  if (Number.isFinite(value)) copy.append(textNode('p', 'rotw-item-tooltip-value', `${valueLabel}: ${Math.max(0, Math.floor(value))} złota`));
  copy.append(textNode('p', 'rotw-item-tooltip-footprint', `Miejsce: ${item.width} × ${item.height}`));
  node.append(copy);
}

function position(node, x, y) {
  const margin = 10;
  node.hidden = false;
  node.style.left = '0px';
  node.style.top = '0px';
  const rect = node.getBoundingClientRect();
  let left = x + 16;
  let top = y + 16;
  if (left + rect.width > innerWidth - margin) left = x - rect.width - 16;
  if (top + rect.height > innerHeight - margin) top = y - rect.height - 16;
  node.style.left = `${Math.max(margin, Math.min(left, innerWidth - rect.width - margin))}px`;
  node.style.top = `${Math.max(margin, Math.min(top, innerHeight - rect.height - margin))}px`;
}

/** Attach the same data-backed Diablo-style hover/focus tooltip in every item view. */
export function attachItemTooltip(trigger, data) {
  if (!trigger || !data?.item) return;
  trigger.dataset.itemTooltip = 'true';
  trigger.setAttribute('aria-describedby', 'rotw-item-tooltip');
  const show = (x, y) => {
    clearTimeout(hideTimer);
    const node = tooltip();
    buildTooltip(node, data);
    position(node, x, y);
  };
  trigger.addEventListener('pointerenter', event => show(event.clientX, event.clientY));
  trigger.addEventListener('pointermove', event => {
    if (tooltipNode?.classList.contains('is-visible')) position(tooltipNode, event.clientX, event.clientY);
  });
  trigger.addEventListener('pointerleave', () => {
    hideTimer = setTimeout(hideItemTooltip, 35);
  });
  trigger.addEventListener('focus', () => {
    const rect = trigger.getBoundingClientRect();
    show(rect.left + rect.width / 2, rect.bottom);
  });
  trigger.addEventListener('blur', () => {
    hideItemTooltip();
  });
}

export const ITEM_TOOLTIP_QUALITY_CLASSES = Object.freeze(Object.fromEntries(
  Object.entries(QUALITY).map(([key, [, className]]) => [key, className]),
));
