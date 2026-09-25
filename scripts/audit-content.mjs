import { importTable } from "../src/node/table-importer.js";
import { readFile } from "node:fs/promises";

const skills = (await importTable("data/skills_manifest.csv")).records;
const quests = (await importTable("data/quest_manifest.csv")).records;
const areas = (await importTable("data/area_manifest.csv")).records;
const completeness = JSON.parse(await readFile("data/content_completeness.json", "utf8"));
const hirelings = JSON.parse(await readFile("data/hireling_manifest.json", "utf8"));
const requiredCategories = ["Classes", "Skills", "Auras", "ItemBases", "Affixes", "UniqueItems", "Sets", "Runes", "Runewords", "Gems", "Jewels", "Charms", "Recipes", "Hirelings", "Monsters", "Areas", "Quests", "NPCServices", "EndgameContent"];
const classes = ["amazon", "assassin", "barbarian", "druid", "necromancer", "paladin", "sorceress", "warlock"];
const counts = Object.fromEntries(classes.map((classId) => [classId, skills.filter((skill) => skill.class === classId).length]));
const ids = skills.map((skill) => skill.original_id);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
const report = {
  dataset: "d2r-rotw-3.3-private-offline-audit-2026-09-12-v1",
  skills: {
    records: skills.length,
    byClass: counts,
    expectedPerClass: 30,
    incompleteClasses: classes.filter((classId) => counts[classId] !== 30),
    duplicateIds,
    verifiedMechanics: skills.filter((skill) => skill.implementation_status === "implemented").length,
  },
  quests: { records: quests.length, implemented: quests.filter((quest) => quest.implementation_status === "implemented").length },
  areas: { records: areas.length, implemented: areas.filter((area) => area.implementation_status === "implemented").length, presentationPrototypes: areas.filter((area) => area.implementation_status === "presentation_prototype").length },
  hirelings: {
    records: hirelings.records.length,
    canonicalIds: hirelings.records.map(({ canonical_id }) => canonical_id),
    mechanicsImplemented: hirelings.records.filter(({ mechanicsImplemented }) => mechanicsImplemented).length,
  },
  completeness: {
    status: completeness.status,
    categoriesPresent: Object.keys(completeness.categories).length,
    missingCategories: requiredCategories.filter((category) => !completeness.categories[category]),
    fullyImplementedCategories: Object.entries(completeness.categories).filter(([, value]) => value.required !== null && value.mechanicsImplemented === value.required).map(([category]) => category),
    missingIdentifiers: Object.entries(completeness.categories).flatMap(([category, value]) => (value.missingIdentifiers ?? []).map((id) => `${category}:${id}`)),
  },
};
console.log(JSON.stringify(report, null, 2));
