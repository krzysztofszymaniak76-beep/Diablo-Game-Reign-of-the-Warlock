import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EquipmentCatalog } from '../src/core/equipment.js';
import { CAMP_VENDOR_POOLS } from '../src/core/camp-services.js';
import { tradeItemArtworkMarkup } from '../app/trade-item-art-v0518.js';
import { ITEM_TOOLTIP_QUALITY_CLASSES } from '../app/item-tooltip-v0518.js';

const readJson = path => readFile(new URL(path, import.meta.url), 'utf8').then(JSON.parse);
const data = await readJson('../data/equipment.v051.json');
const manifest = await readJson('../data/d2r-control-weapon-art.v0518.json');
const catalog = new EquipmentCatalog(data);

test('pula Charsi skupia bronie fizyczne i lekkie pancerze, a różdżka jest u Akary', () => {
  const expectedWeapons = ['hand_axe','great_axe','short_sword','two_handed_sword','great_sword','dagger',
    'war_hammer','flail','spear','war_staff','hunters_bow','light_crossbow','throwing_axe','club','katar'];
  const expectedArmor = ['quilted_armor','cap','buckler','leather_gloves','boots','sash'];
  assert.deepEqual(CAMP_VENDOR_POOLS.charsi, [...expectedWeapons, ...expectedArmor]);
  assert.deepEqual(manifest.controlBatch, ['hand_axe','great_axe','short_sword','two_handed_sword','great_sword','dagger',
    'war_hammer','flail','spear','war_staff','wand','hunters_bow','light_crossbow','throwing_axe','katar']);
  assert.ok(CAMP_VENDOR_POOLS.akara.includes('wand'));
  assert.equal(new Set(CAMP_VENDOR_POOLS.charsi).size, 21);
});

test('wszystkie grafiki broni są oryginalnymi sprite’ami i zgadzają się z footprintem bazy', async () => {
  assert.equal(manifest.assets.length, 18);
  for (const asset of manifest.assets) {
    const definition = catalog.get(asset.canonicalId);
    assert.ok(definition && definition.kind === 'weapon', `${asset.canonicalId} ma bazę broni`);
    assert.equal(asset.sourceRecord.table, 'weapons.txt');
    assert.ok(asset.sourceVirtualPath.startsWith('data:data\\hd\\global\\ui\\items\\weapon\\'));
    const image = await readFile(new URL(`../${asset.file}`, import.meta.url));
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.readUInt32BE(16), definition.width * 98, `${asset.canonicalId} PNG width`);
    assert.equal(image.readUInt32BE(20), definition.height * 98, `${asset.canonicalId} PNG height`);
    assert.equal(asset.width, definition.width * 98);
    assert.equal(asset.height, definition.height * 98);
    assert.equal(tradeItemArtworkMarkup(asset.canonicalId).includes(`/app/assets/items/${asset.canonicalId}.png`), true);
    assert.equal(tradeItemArtworkMarkup(asset.canonicalId).includes('<svg'), false, `${asset.canonicalId} is not fallback art`);
  }
});

test('topór miotany zachowuje źródłową ilość stosu, obrażenia rzutu i footprint 1x2', () => {
  const axe = catalog.get('throwing_axe');
  assert.deepEqual(axe.throwDamage, [8, 12]);
  assert.equal(axe.stackable, true);
  assert.deepEqual([axe.minStack, axe.maxStack, axe.spawnStack], [24, 200, 48]);
  assert.deepEqual([axe.width, axe.height], [1, 2]);
});

test('kolory jakości obsługują wszystkie wymagane warianty tooltipa', () => {
  assert.deepEqual(ITEM_TOOLTIP_QUALITY_CLASSES, {
    normal: 'normal', magic: 'magic', rare: 'rare', unique: 'unique', set: 'set',
    crafted: 'crafted', superior: 'superior',
  });
});
