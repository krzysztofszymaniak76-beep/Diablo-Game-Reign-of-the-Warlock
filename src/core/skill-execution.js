import { canPaySkillMana } from './skill-mana.js';
import { isCorpseTarget } from './corpses.js';

export const SKILL_EXECUTION_SCHEMA_VERSION = 1;
export const SkillTarget = Object.freeze({
  ENEMY: 'enemy', GROUND: 'ground', CORPSE: 'corpse', SELF: 'self',
  AURA: 'aura', ALLY: 'ally', PET: 'pet', ITEM: 'item', PASSIVE: 'passive',
});

// The source owns special targeting flags. Runtime categories refine the
// source's generic world target for this existing twenty-skill vertical slice.
export function skillTargetMode(source, runtime) {
  if (source.passive) return SkillTarget.PASSIVE;
  if (source.aura) return SkillTarget.AURA;
  for (const [flag, mode] of [['corpse', SkillTarget.CORPSE], ['ally', SkillTarget.ALLY], ['pet', SkillTarget.PET], ['item', SkillTarget.ITEM]]) {
    if (source.targeting[flag]) return mode;
  }
  if (runtime.category === 'summon') return SkillTarget.GROUND;
  if (runtime.category === 'buff') return SkillTarget.SELF;
  if (runtime.category === 'offensive') return SkillTarget.ENEMY;
  throw new Error(`Nieobsługiwany tryb celu: ${runtime.id}`);
}

export function validateSkillTarget(mode, { hasHex = false, enemy = false, freeGround = false, corpse = null } = {}) {
  if (mode === SkillTarget.ENEMY && enemy) return true;
  if (mode === SkillTarget.GROUND && hasHex && freeGround) return true;
  if (mode === SkillTarget.SELF || mode === SkillTarget.AURA) return true;
  if (mode === SkillTarget.CORPSE) {
    // TODO: integrate saved battlefield death/corpse lifecycle into actual
    // Corpse Explosion and future corpse skills; Raise Skeleton is now wired
    // through the dedicated atomic summon runtime.
    if (isCorpseTarget(corpse) && corpse.consumed === false) return true;
    throw new Error('Wymaga dostępnych zwłok; system celu-ciała nie jest jeszcze podłączony');
  }
  if ([SkillTarget.ALLY, SkillTarget.PET, SkillTarget.ITEM, SkillTarget.PASSIVE].includes(mode)) {
    throw new Error(`Ten tryb celu nie jest jeszcze obsługiwany: ${mode}`);
  }
  throw new Error(mode === SkillTarget.GROUND ? 'Wskaż pusty heks przywołania' : 'Wskaż żywego przeciwnika');
}

export function validateSkillExecution(value) {
  const keys = ['schemaVersion', 'skillId', 'skillLevel', 'side', 'weaponFingerprint'].sort();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== keys.join('|')
    || value.schemaVersion !== SKILL_EXECUTION_SCHEMA_VERSION
    || typeof value.skillId !== 'string' || !value.skillId.trim() || value.skillId !== value.skillId.trim()
    || !Number.isSafeInteger(value.skillLevel) || value.skillLevel < 1 || value.skillLevel > 999
    || ![null, 'left', 'right'].includes(value.side)
    || (value.weaponFingerprint !== null && (typeof value.weaponFingerprint !== 'string' || !value.weaponFingerprint))) {
    throw new Error('Nieprawidłowy opis wykonania umiejętności');
  }
  return Object.freeze({ ...value });
}

export function weaponFingerprint(character, profile) {
  if (!['equipment', 'shield'].includes(profile?.damageOrigin)) return null;
  return JSON.stringify({ weapon: character.equipment.weapon ?? null, offhand: character.equipment.offhand ?? null });
}

export function createSkillExecution({ character, skill, skillLevel, side = null, profile }) {
  return validateSkillExecution({
    schemaVersion: SKILL_EXECUTION_SCHEMA_VERSION,
    skillId: skill.id, skillLevel, side,
    weaponFingerprint: weaponFingerprint(character, profile),
  });
}

export function checkSkillExecution(execution, { character, skill, source, skillLevel, knownSkillIds, profile, allowDefeatedSource = false }) {
  validateSkillExecution(execution);
  if (!allowDefeatedSource && (character.lifeState !== 'alive' || character.resources.hp <= 0)) throw new Error('Aktor nie żyje');
  if (!skill || source.runtimeId !== execution.skillId || skill.id !== execution.skillId
    || !knownSkillIds.includes(execution.skillId) || source.passive
    || (execution.side !== null && !source.mouse[execution.side])) {
    throw new Error('Umiejętność nie jest już legalna dla aktora lub przycisku');
  }
  if (execution.skillLevel !== skillLevel) throw new Error('Poziom umiejętności zmienił się od zaplanowania rozkazu');
  if (!profile || profile.error) throw new Error(profile?.error ?? 'Brak legalnego profilu ataku');
  if (execution.weaponFingerprint !== weaponFingerprint(character, profile)) throw new Error('Broń zmieniła się od zaplanowania rozkazu');
  const mana = canPaySkillMana(character.resources.mana, source, skillLevel);
  if (!mana.affordable) throw new Error('Za mało many');
  return { mana, profile };
}

// UI events and authoritative timeline commands have separate identities.
// Ignore repeated delivery and the second click of a double-click, even if
// the synchronous timeline has already made another hero ready by then.
export class WorldInputGuard {
  #seen = new WeakSet();
  #last = null;

  accept(event, hex, now = performance.now()) {
    if (this.#seen.has(event)) return false;
    this.#seen.add(event);
    if (event.detail > 1 || event.repeat) return false;
    const key = `${event.type}:${event.button ?? 0}:${hex?.q},${hex?.r}`;
    if (this.#last?.key === key && now >= this.#last.at && now - this.#last.at < 300) return false;
    this.#last = { key, at: now };
    return true;
  }
}
