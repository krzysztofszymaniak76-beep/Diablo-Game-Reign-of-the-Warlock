import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngRoot = path.join(root, 'app', 'assets', 'items');
const equipment = JSON.parse(await readFile(path.join(root, 'data', 'equipment.v051.json'), 'utf8'));
const sourceDir = 'data:data\\hd\\global\\ui\\items\\weapon\\';
const sprites = {
  club: 'club\\club.sprite', hand_axe: 'axe\\hand_axe.sprite', great_axe: 'axe\\great_axe.sprite',
  short_sword: 'sword\\short_sword.sprite', two_handed_sword: 'sword\\two_handed_sword.sprite',
  great_sword: 'sword\\great_sword.sprite', dagger: 'knife\\dagger.sprite', war_hammer: 'hammer\\war_hammer.sprite',
  spear: 'spear\\spear.sprite', war_staff: 'staff\\war_staff.sprite', wand: 'wand\\wand.sprite',
  hunters_bow: 'bow\\hunters_bow.sprite', light_crossbow: 'bow\\light_crossbow.sprite',
  throwing_axe: 'axe\\throwing_axe.sprite', katar: 'h2h\\katar.sprite', flail: 'mace\\flail.sprite',
  scepter: 'scepter\\scepter.sprite', grand_scepter: 'scepter\\grand_scepter.sprite',
};
const controlBatch = [
  'hand_axe', 'great_axe', 'short_sword', 'two_handed_sword', 'great_sword', 'dagger',
  'war_hammer', 'flail', 'spear', 'war_staff', 'wand', 'hunters_bow', 'light_crossbow',
  'throwing_axe', 'katar',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const byId = new Map(equipment.bases.map(base => [base.id, base]));
const assets = [];
for (const [canonicalId, relativeSource] of Object.entries(sprites)) {
  const definition = byId.get(canonicalId);
  if (!definition || definition.kind !== 'weapon') throw new Error(`Missing weapon definition: ${canonicalId}`);
  const filename = `${canonicalId}.png`;
  const bytes = await readFile(path.join(pngRoot, filename));
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Not a PNG: ${filename}`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== definition.width * 98 || height !== definition.height * 98) {
    throw new Error(`${canonicalId}: art ${width}x${height} does not match grid ${definition.width}x${definition.height}`);
  }
  assets.push({
    canonicalId,
    file: `app/assets/items/${filename}`,
    sourceVirtualPath: sourceDir + relativeSource,
    sourceRecord: definition.source,
    width,
    height,
    sha256: sha256(bytes),
  });
}
const manifest = {
  schemaVersion: 1,
  projectVersion: '0.5.18',
  purpose: 'staged D2R weapon art/control batch; not a complete item catalogue',
  artworkOrigin: 'Local Diablo II: Resurrected installation CASC .sprite files; decoded losslessly to RGBA PNG, no generated or redrawn weapon shapes.',
  controlBatch,
  assets,
};
const output = path.join(root, 'data', 'd2r-control-weapon-art.v0518.json');
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Created ${output}: ${assets.length} source-mapped weapon sprites; ${controlBatch.length} control items.`);
