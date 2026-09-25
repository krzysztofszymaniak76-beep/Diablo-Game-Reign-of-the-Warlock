import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { HERO_FIGURE_SHEET, HERO_VISUALS } from "../src/core/hero-visuals.js";
import { STARTER_ROSTER_DEFINITIONS } from "../src/core/starter-roster.js";

test("all playable classes use full-body and bust crops from the canonical selection sheet", () => {
  const classes = new Set(STARTER_ROSTER_DEFINITIONS.map(({ classId }) => classId));
  assert.equal(classes.size, 8);
  assert.deepEqual([...classes].sort(), Object.keys(HERO_VISUALS).sort());
  assert.equal(existsSync(new URL(`..${HERO_FIGURE_SHEET}`, import.meta.url)), true);

  for (const [classId, visual] of Object.entries(HERO_VISUALS)) {
    assert.equal(visual.rect.length, 4, classId);
    assert.ok(visual.rect.every(Number.isInteger), classId);
    assert.ok(visual.rect[0] >= 0 && visual.rect[1] >= 0
      && visual.rect[0] + visual.rect[2] <= 1672
      && visual.rect[1] + visual.rect[3] <= 941, classId);
    assert.match(visual.spritePath, new RegExp(`unit-canonical-${classId}-v1\\.png$`));
    assert.match(visual.portraitPath, new RegExp(`unit-canonical-${classId}-portrait-v1\\.png$`));
    assert.equal(existsSync(new URL(`..${visual.spritePath}`, import.meta.url)), true, `${classId} sprite`);
    assert.equal(existsSync(new URL(`..${visual.portraitPath}`, import.meta.url)), true, `${classId} portrait`);
  }

  for (const definition of STARTER_ROSTER_DEFINITIONS) {
    assert.equal(definition.spritePath, HERO_VISUALS[definition.classId].spritePath, definition.id);
  }
});
