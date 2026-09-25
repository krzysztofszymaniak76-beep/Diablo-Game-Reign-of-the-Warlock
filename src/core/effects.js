export class EffectRegistry {
  constructor() {
    this.effects = new Map();
  }

  add(effect) {
    if (!effect?.id || !effect?.sourceId || !effect?.targetId) throw new TypeError("Effect requires id, sourceId and targetId");
    if (effect.persistsWhenSourceWithdrawn !== undefined
      && typeof effect.persistsWhenSourceWithdrawn !== "boolean") {
      throw new TypeError("persistsWhenSourceWithdrawn must be a boolean");
    }
    if (this.effects.has(effect.id)) throw new Error(`Duplicate effect id: ${effect.id}`);
    this.effects.set(effect.id, structuredClone(effect));
  }

  removeBySource(sourceId, { persistent = false } = {}) {
    const removed = [];
    for (const [id, effect] of this.effects) {
      if (effect.sourceId === sourceId && (persistent || !effect.persistsWhenSourceWithdrawn)) {
        removed.push(effect);
        this.effects.delete(id);
      }
    }
    return removed;
  }

  removeByTarget(targetId) {
    const removed = [];
    for (const [id, effect] of this.effects) {
      if (effect.targetId !== targetId) continue;
      removed.push(effect);
      this.effects.delete(id);
    }
    return structuredClone(removed);
  }

  removeByUnit(unitId, { persistent = false } = {}) {
    const removed = [];
    for (const [id, effect] of this.effects) {
      const removeSource = effect.sourceId === unitId
        && (persistent || !effect.persistsWhenSourceWithdrawn);
      const removeTarget = effect.targetId === unitId;
      if (!removeSource && !removeTarget) continue;
      removed.push(effect);
      this.effects.delete(id);
    }
    return structuredClone(removed);
  }

  forTarget(targetId) {
    return [...this.effects.values()].filter((effect) => effect.targetId === targetId);
  }

  resolvedForTarget(targetId) {
    const groups = new Map();
    for (const effect of this.forTarget(targetId)) {
      const key = effect.stackKey ?? effect.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(effect);
    }
    const resolved = [];
    for (const effects of groups.values()) {
      const policy = effects[0].stackPolicy ?? "independent";
      if (policy === "strongest") {
        resolved.push(effects.toSorted((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.id.localeCompare(b.id))[0]);
      } else if (policy === "independent") {
        resolved.push(...effects);
      } else {
        throw new Error(`Unknown effect stacking policy: ${policy}`);
      }
    }
    return structuredClone(resolved);
  }

  snapshot() {
    return structuredClone([...this.effects.values()]);
  }
}
