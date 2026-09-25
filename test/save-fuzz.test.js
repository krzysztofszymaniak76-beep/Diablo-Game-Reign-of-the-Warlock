import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CampaignState } from '../src/core/campaign.js';
import { createCharacter, Roster } from '../src/core/characters.js';
import { GameState } from '../src/core/state.js';
import { loadGame, removeSaveArtifacts, saveAtomic } from '../src/node/save-store.js';

function cleanSave() {
  const roster = new Roster([
    createCharacter({ id: 'save-a', name: 'Save A', classId: 'barbarian' }),
    createCharacter({ id: 'save-b', name: 'Save B', classId: 'paladin' }),
  ]);
  return new GameState({ roster, partyIds: ['save-a'], campaign: new CampaignState({ worldSeed: 41 }), players: 1, items: [] }).serialize();
}

test('save fuzz rejects malformed hero identity, party ownership and mana without mutation', () => {
  const mutations = [
    save => { delete save.roster[0].id; },
    save => { save.roster[1].id = save.roster[0].id; },
    save => { save.partyIds = ['ghost']; },
    save => { save.roster[0].resources.mana = -1; },
    save => { save.roster[0].resources.mana = Number.NaN; },
    save => { save.roster[0].resources.mana = '3'; },
    save => { save.roster[0].resources.mana = save.roster[0].resources.maxMana + 1; },
    save => { delete save.roster[0].resources.maxMana; },
  ];
  for (const mutate of mutations) {
    const broken = cleanSave();
    mutate(broken);
    assert.throws(() => GameState.deserialize(broken));
  }
  assert.equal(GameState.deserialize(cleanSave()).roster.get('save-a').resources.mana, 10);
});

test('truncated, empty and object JSON never replace a validated backup', async () => {
  const root = path.resolve('work', 'save-fuzz-backup');
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'save.json');
  await removeSaveArtifacts(file);
  const first = new GameState({
    roster: new Roster([createCharacter({ id: 'backup-fuzz', name: 'Backup Fuzz', classId: 'amazon' })]),
    partyIds: ['backup-fuzz'], campaign: new CampaignState({ worldSeed: 91 }), players: 3, items: [],
  });
  await saveAtomic(file, first);
  const second = GameState.deserialize(first.serialize());
  second.players.set(7);
  await saveAtomic(file, second);
  const goodBackup = await readFile(`${file}.bak`, 'utf8');
  for (const corrupted of ['{', '', '{}', 'null', '[]']) {
    await writeFile(file, corrupted, 'utf8');
    const restored = await loadGame(file);
    assert.equal(restored.players.value, 3, corrupted || '<empty>');
    assert.equal(await readFile(`${file}.bak`, 'utf8'), goodBackup);
  }
  await removeSaveArtifacts(file);
});
