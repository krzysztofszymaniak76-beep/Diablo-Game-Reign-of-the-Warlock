import { MOUSE_SKILL_SCHEMA_VERSION } from './mouse-skills.js';
import { validateSkillExecution } from './skill-execution.js';

export const ACTIVE_AURA_SAVE_SCHEMA_VERSION = 1;

// Validate the original envelope before replacing a compatible legacy catalog
// id. Otherwise an inconsistent nested header can masquerade as a migration.
export function migrateMouseSkillSnapshot(envelope, { catalog, legacyCatalogIds = new Set() }) {
  const fields = ['mouseSkillSchemaVersion', 'mouseSkillCatalogId', 'mouseSkills'];
  const present = fields.map(key => envelope[key] !== undefined);
  if (!present.some(Boolean)) return { snapshot: null, migrated: true };
  if (!present.every(Boolean)) throw new Error('Niekompletny nagłówek sterowania LPM/PPM');
  const supported = envelope.mouseSkillCatalogId === catalog.id || legacyCatalogIds.has(envelope.mouseSkillCatalogId);
  if (envelope.mouseSkillSchemaVersion !== MOUSE_SKILL_SCHEMA_VERSION || !supported) {
    throw new Error('Nieobsługiwany katalog lub schemat sterowania LPM/PPM');
  }
  if (envelope.mouseSkills?.schemaVersion !== envelope.mouseSkillSchemaVersion
    || envelope.mouseSkills?.catalogId !== envelope.mouseSkillCatalogId) {
    throw new Error('Nagłówek LPM/PPM jest niespójny z zapisanymi przypisaniami');
  }
  return {
    snapshot: { ...structuredClone(envelope.mouseSkills), catalogId: catalog.id },
    migrated: envelope.mouseSkillCatalogId !== catalog.id,
  };
}

// Buffs remain the single source of truth for active auras. The saved index is
// cross-checked rather than becoming another mutable aura system.
export function buildActiveAuraSnapshot({ heroIds, buffs, catalog }) {
  if (!Array.isArray(heroIds) || new Set(heroIds).size !== heroIds.length || !Array.isArray(buffs)) {
    throw new TypeError('Nieprawidłowa lista bohaterów lub aur');
  }
  const active = new Map(heroIds.map(id => [id, null]));
  for (const buff of buffs) {
    if (!catalog.has(buff.skillId) || !catalog.get(buff.skillId).aura) continue;
    if (!active.has(buff.sourceId)) throw new Error('Aura ma nieznanego właściciela');
    if (buff.exclusiveGroup !== `aura:${buff.sourceId}` || buff.originalTurns !== null || buff.remainingTurns !== null) {
      throw new Error('Aura musi należeć do jednej trwałej grupy własnych aur bohatera');
    }
    if (active.get(buff.sourceId) !== null) throw new Error('Bohater nie może mieć dwóch własnych aur jednocześnie');
    active.set(buff.sourceId, buff.skillId);
  }
  return heroIds.map(heroId => ({ heroId, activeAuraSkillId: active.get(heroId) }));
}

export function validateActiveAuraSnapshot(envelope, options) {
  const expected = buildActiveAuraSnapshot(options);
  const hasVersion = envelope.activeAuraSchemaVersion !== undefined;
  const hasAuras = envelope.activeAuras !== undefined;
  if (!hasVersion && !hasAuras) return { snapshot: expected, migrated: true };
  if (!hasVersion || !hasAuras) throw new Error('Niekompletny nagłówek aktywnych aur');
  if (envelope.activeAuraSchemaVersion !== ACTIVE_AURA_SAVE_SCHEMA_VERSION) throw new Error('Nieobsługiwany schemat aktywnych aur');
  if (!Array.isArray(envelope.activeAuras) || envelope.activeAuras.length !== expected.length) {
    throw new Error('Niekompletna lista aktywnych aur bohaterów');
  }
  const byHero = new Map();
  for (const entry of envelope.activeAuras) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join('|') !== 'activeAuraSkillId|heroId'
      || typeof entry.heroId !== 'string' || byHero.has(entry.heroId)) {
      throw new Error('Nieprawidłowy lub powielony wpis aktywnej aury');
    }
    byHero.set(entry.heroId, entry.activeAuraSkillId);
  }
  for (const entry of expected) {
    if (!byHero.has(entry.heroId) || byHero.get(entry.heroId) !== entry.activeAuraSkillId) {
      throw new Error('Aktywna aura nie zgadza się z zapisanymi efektami bohatera');
    }
  }
  return { snapshot: expected, migrated: false };
}

export function validatePendingSkillCommands({ combat, heroIds, knownSkillsByHero, catalog, skillDefinitions }) {
  const heroes = new Set(heroIds);
  for (const command of combat.commands.active) {
    if (!heroes.has(command.actorId) || !['attack', 'approachAttack'].includes(command.kind)) continue;
    if (!command.payload?.skillExecution) {
      throw new Error('Nie można wczytać rozpoczętego ataku z v0.5.5: brak informacji o rozliczeniu many. Wczytaj zapis sprzed rozpoczęcia ataku');
    }
    const execution = validateSkillExecution(command.payload.skillExecution);
    const source = catalog.get(execution.skillId);
    const known = knownSkillsByHero[command.actorId];
    const runtime = skillDefinitions[execution.skillId];
    if (command.payload.skillId !== execution.skillId || !known?.includes(execution.skillId)
      || runtime?.category !== 'offensive'
      || command.payload.range !== runtime.range
      || command.payload.attackType !== (runtime.range > 1 ? 'ranged' : 'melee')
      || source.passive || source.aura || Object.values(source.targeting).some(Boolean)
      || (execution.side !== null && !catalog.allows(execution.skillId, execution.side))) {
      throw new Error('Zapisany atak używa nielegalnej umiejętności lub przycisku');
    }
    const validatePayload = payload => {
      const candidate = validateSkillExecution(payload?.skillExecution);
      if (payload.skillId !== execution.skillId || payload.manaCost !== undefined
        || Object.keys(execution).some(key => candidate[key] !== execution[key])) {
        throw new Error('Zapisany atak ma niespójny opis wykonania lub podmieniony koszt many');
      }
    };
    validatePayload(command.payload);
    for (const event of combat.scheduler.queue) {
      if (event.payload?.commandId === command.commandId && event.kind !== 'projectile:step') validatePayload(event.payload);
    }
    const transaction = combat.commands.transactions.find(([id]) => id === command.transactionId)?.[1];
    for (const event of transaction?.result?.events ?? []) {
      if (event.kind !== 'projectile:step') validatePayload(event.payload);
    }
  }
}
