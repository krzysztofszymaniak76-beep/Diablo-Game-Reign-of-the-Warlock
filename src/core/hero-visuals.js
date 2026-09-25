/**
 * Canonical hero art is cropped directly from the approved character-select
 * figure sheet. Full-body sprites and bust portraits therefore share the same
 * source pixels; IDs, names, and save data remain independent of this mapping.
 */
export const HERO_FIGURE_SHEET = "/app/assets/character-select-original-figures-v2.png";

export const HERO_VISUALS = Object.freeze({
  amazon: Object.freeze({ rect: [0, 311, 274, 466], spritePath: "/app/assets/unit-canonical-amazon-v1.png", portraitPath: "/app/assets/unit-canonical-amazon-portrait-v1.png" }),
  assassin: Object.freeze({ rect: [269, 340, 150, 435], spritePath: "/app/assets/unit-canonical-assassin-v1.png", portraitPath: "/app/assets/unit-canonical-assassin-portrait-v1.png" }),
  necromancer: Object.freeze({ rect: [412, 300, 191, 472], spritePath: "/app/assets/unit-canonical-necromancer-v1.png", portraitPath: "/app/assets/unit-canonical-necromancer-portrait-v1.png" }),
  barbarian: Object.freeze({ rect: [597, 269, 266, 509], spritePath: "/app/assets/unit-canonical-barbarian-v1.png", portraitPath: "/app/assets/unit-canonical-barbarian-portrait-v1.png" }),
  paladin: Object.freeze({ rect: [847, 301, 245, 476], spritePath: "/app/assets/unit-canonical-paladin-v1.png", portraitPath: "/app/assets/unit-canonical-paladin-portrait-v1.png" }),
  sorceress: Object.freeze({ rect: [1075, 320, 195, 454], spritePath: "/app/assets/unit-canonical-sorceress-v1.png", portraitPath: "/app/assets/unit-canonical-sorceress-portrait-v1.png" }),
  warlock: Object.freeze({ rect: [1266, 305, 181, 470], spritePath: "/app/assets/unit-canonical-warlock-v1.png", portraitPath: "/app/assets/unit-canonical-warlock-portrait-v1.png" }),
  druid: Object.freeze({ rect: [1438, 289, 234, 490], spritePath: "/app/assets/unit-canonical-druid-v1.png", portraitPath: "/app/assets/unit-canonical-druid-portrait-v1.png" }),
});

export function canonicalHeroSpritePath(classId) {
  const visual = HERO_VISUALS[classId];
  if (!visual) throw new RangeError(`Unknown class: ${classId}`);
  return visual.spritePath;
}

export function canonicalHeroPortraitPath(classId) {
  const visual = HERO_VISUALS[classId];
  if (!visual) throw new RangeError(`Unknown class: ${classId}`);
  return visual.portraitPath;
}
