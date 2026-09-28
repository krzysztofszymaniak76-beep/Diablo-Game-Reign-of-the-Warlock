export const SKILL_HOTKEYS = Object.freeze(Array.from({ length: 8 }, (_, i) => `F${i + 1}`));

// Hotkeys select a hand action; they never execute a spell or advance time.
export class SkillHotkeys {
  #heroes;
  #bindings = new Map();
  constructor(heroIds, saved) {
    this.#heroes = new Set(heroIds);
    if (saved === undefined) return; // Backwards-compatible empty bindings.
    if (saved?.schemaVersion !== 1 || !Array.isArray(saved.bindings)) throw new Error('Nieprawidłowy zapis F1–F8');
    for (const entry of saved.bindings) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'heroId,key,side,skillId') throw new Error('Nieprawidłowy skrót umiejętności');
      const id = `${entry.heroId}:${entry.key}`;
      if (this.#bindings.has(id)) throw new Error('Powielony skrót umiejętności');
      this.assign(entry.heroId, entry.key, entry.side, entry.skillId);
    }
  }
  assign(heroId, key, side, skillId) {
    if (!this.#heroes.has(heroId) || !SKILL_HOTKEYS.includes(key)
      || !['left', 'right'].includes(side) || typeof skillId !== 'string' || !skillId.trim()) {
      throw new Error('Nieprawidłowe przypisanie F1–F8');
    }
    // A particular hand/skill has one visible label, as in the action popup.
    for (const [id, binding] of this.#bindings) {
      if (binding.heroId === heroId && binding.side === side && binding.skillId === skillId) this.#bindings.delete(id);
    }
    this.#bindings.set(`${heroId}:${key}`, { heroId, key, side, skillId });
  }
  get(heroId, key) { return structuredClone(this.#bindings.get(`${heroId}:${key}`) ?? null); }
  label(heroId, side, skillId) {
    return [...this.#bindings.values()].find(b => b.heroId === heroId && b.side === side && b.skillId === skillId)?.key ?? '';
  }
  snapshot() { return { schemaVersion: 1, bindings: structuredClone([...this.#bindings.values()]) }; }
  retainAvailable(heroId, available) {
    for (const [id,binding] of this.#bindings) {
      if (binding.heroId === heroId && !available(binding.skillId,binding.side)) this.#bindings.delete(id);
    }
  }
}
