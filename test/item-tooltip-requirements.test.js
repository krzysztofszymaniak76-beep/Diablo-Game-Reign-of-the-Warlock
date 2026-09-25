import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EquipmentCatalog, initializeEquipmentAttributes } from '../src/core/equipment.js';
import { createCharacter } from '../src/core/characters.js';
import { unmetItemRequirementCopy } from '../app/item-tooltip-v0518.js';

const equipmentData = JSON.parse(readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8'));
const catalog = new EquipmentCatalog(equipmentData);

test('Targa tooltip explains the actual level blocker for a level-one Paladin', () => {
  const paladin = createCharacter({ id: 'hadriel', name: 'Hadriel', classId: 'paladin' });
  initializeEquipmentAttributes(paladin, catalog);
  const targa = catalog.get('targe');

  assert.equal(paladin.stats.strength, 25);
  assert.equal(unmetItemRequirementCopy(targa, paladin),
    'Nie możesz teraz założyć: Wymagany poziom 3 (masz 1)');

  paladin.level = 3;
  assert.equal(unmetItemRequirementCopy(targa, paladin), '');
});
