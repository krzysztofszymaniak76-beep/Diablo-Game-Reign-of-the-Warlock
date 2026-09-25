export const CHARACTER_CLASSES = Object.freeze([
  "amazon",
  "assassin",
  "barbarian",
  "druid",
  "necromancer",
  "paladin",
  "sorceress",
  "warlock",
]);

export const DIFFICULTIES = Object.freeze(["normal", "nightmare", "hell"]);
// The tactical battlefield is intentionally limited to three main heroes.
// The roster may still contain reserves and summons are tracked separately.
export const MAX_PARTY_SIZE = 3;
export const MAX_SKILL_POINTS = 20;

// Minimal runtime defaults only. Exact per-class values remain data-gated until
// their patch 3.3 table source is supplied and verified.
export const PROVISIONAL_CLASS_RESOURCES = Object.freeze({
  amazon: { life: 50, mana: 15 },
  assassin: { life: 50, mana: 25 },
  barbarian: { life: 55, mana: 10 },
  druid: { life: 55, mana: 20 },
  necromancer: { life: 45, mana: 25 },
  paladin: { life: 55, mana: 15 },
  sorceress: { life: 40, mana: 35 },
  warlock: { life: 45, mana: 30 },
});
