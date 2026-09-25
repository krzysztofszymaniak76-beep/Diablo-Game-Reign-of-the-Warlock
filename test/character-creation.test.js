import test from "node:test";
import assert from "node:assert/strict";
import {
  ALTERNATE_CHARACTER_SPRITES,
  DEFAULT_GENDER_BY_CLASS,
  normalizeCreationProfile,
  spriteKeyForGender,
} from "../app/character-creation.js";

test("legacy cosmetic asset mappings remain readable without changing class defaults", () => {
  assert.equal(Object.keys(DEFAULT_GENDER_BY_CLASS).length, 8);
  for (const [classId, defaultGender] of Object.entries(DEFAULT_GENDER_BY_CLASS)) {
    assert.equal(spriteKeyForGender(classId, defaultGender), classId);
    const alternateGender = defaultGender === "male" ? "female" : "male";
    const alternateKey = spriteKeyForGender(classId, alternateGender);
    assert.equal(alternateKey, `${classId}:${alternateGender}`);
    assert.match(ALTERNATE_CHARACTER_SPRITES[alternateKey], /^\/app\/assets\/unit-[\w-]+\.png$/);
  }
});

test("creation mode and legacy appearance data round-trip while older saves default to Normal", () => {
  assert.deepEqual(normalizeCreationProfile(undefined), { schemaVersion: 1, mode: "normal", genders: {} });
  assert.deepEqual(normalizeCreationProfile({ schemaVersion: 1, mode: "hardcore",
    genders: { korgan: "female", isendra: "male" } }), {
    schemaVersion: 1, mode: "hardcore", genders: { korgan: "female", isendra: "male" },
  });
  assert.throws(() => normalizeCreationProfile({ schemaVersion: 1, mode: "unknown", genders: {} }),
    /profil/);
  assert.throws(() => normalizeCreationProfile({ schemaVersion: 1, mode: "normal", genders: { korgan: "robot" } }),
    /wygląd/);
});
