import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gameRoot = process.env.ROTW_D2R_INSTALL_DIR ?? 'C:/Program Files (x86)/Diablo II Resurrected';
const assetsRoot = path.join(root, 'app', 'assets', 'items');
const entries = [
  ['cap', 'cap.png', 'armor\\helmet\\cap_hat.sprite', 2, 2],
  ['quilted_armor', 'quilted_armor.png', 'armor\\armor\\quilted_armor.sprite', 2, 3],
  ['buckler', 'buckler.png', 'armor\\shield\\buckler.sprite', 2, 2],
  ['targe', 'targe.png', 'armor\\shield\\targe.sprite', 2, 2],
  ['leather_gloves', 'leather_gloves.png', 'armor\\glove\\gloves_l.sprite', 2, 2],
  ['boots', 'boots.png', 'armor\\boot\\leather_boots.sprite', 2, 2],
  ['sash', 'sash.png', 'armor\\belt\\sash_l.sprite', 2, 1],
  ['tome_identify', 'tome_identify.png', 'misc\\book\\identify_book.sprite', 1, 2],
  ['tome_town_portal', 'tome_town_portal.png', 'misc\\book\\town_portal_book.sprite', 1, 2],
  ['scroll_identify', 'scroll_identify.png', 'misc\\scroll\\identify_scroll.sprite', 1, 1],
  ['scroll_town_portal', 'scroll_town_portal.png', 'misc\\scroll\\town_portal_scroll.sprite', 1, 1],
  ['potion_health_lesser', 'potion_health_lesser.png', 'misc\\potion\\lesser_healing_potion.sprite', 1, 1],
  ['potion_health_light', 'potion_health_light.png', 'misc\\potion\\light_healing_potion.sprite', 1, 1],
  ['potion_health', 'potion_health.png', 'misc\\potion\\healing_potion.sprite', 1, 1],
  ['potion_mana_lesser', 'potion_mana_lesser.png', 'misc\\potion\\lesser_mana_potion.sprite', 1, 1],
  ['potion_mana_light', 'potion_mana_light.png', 'misc\\potion\\light_mana_potion.sprite', 1, 1],
  ['potion_mana', 'potion_mana.png', 'misc\\potion\\mana_potion.sprite', 1, 1],
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const buildInfo = await readFile(path.join(gameRoot, '.build.info'));
const assets = [];
for (const [canonicalId, file, virtualPath, columns, rows] of entries) {
  const bytes = await readFile(path.join(assetsRoot, file));
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Not PNG: ${file}`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== columns * 98 || height !== rows * 98) {
    throw new Error(`${canonicalId}: ${width}x${height}; expected ${columns * 98}x${rows * 98}`);
  }
  assets.push({
    canonicalId,
    file: `app/assets/items/${file}`,
    sourceVirtualPath: `data:data\\hd\\global\\ui\\items\\${virtualPath}`,
    width,
    height,
    sha256: digest(bytes),
  });
}
const manifest = {
  schemaVersion: 1,
  projectVersion: '0.5.18',
  purpose: 'source-extracted vendor armor and consumable item art; not a complete item catalogue',
  artworkOrigin: 'Lossless RGBA PNG conversions of selected .sprite files from the local Diablo II: Resurrected installation; no generated or redrawn item shapes.',
  localBuildInfoSha256: digest(buildInfo),
  assets,
};
const output = path.join(root, 'data', 'd2r-vendor-item-art.v0518.json');
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Created ${output}: ${assets.length} source-mapped armor/supply sprites, dimensions and hashes verified.`);
