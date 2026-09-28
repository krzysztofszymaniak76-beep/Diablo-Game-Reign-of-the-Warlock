export const SKILL_TREE_SCHEMA_VERSION = 1;

const CLASS_IDS = new Set([
  'amazon', 'assassin', 'barbarian', 'druid', 'necromancer', 'paladin', 'sorceress', 'warlock',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function skillState(character, skill) {
  const current = character.skills?.[skill.id] ?? {};
  const hardPoints = Number.isSafeInteger(current.hardPoints) && current.hardPoints >= 0 ? current.hardPoints : 0;
  const softPoints = Number.isSafeInteger(current.softPoints) && current.softPoints >= 0 ? current.softPoints : 0;
  return { hardPoints, softPoints, effectiveLevel: hardPoints + softPoints };
}

function normalizedSkillId(classId, skill) {
  return skill.id.startsWith(`${classId}.`) ? skill.id : `${classId}.${skill.id}`;
}

export class SkillTreeCatalog {
  #payload;
  #classes;
  #skillsById;
  #skillsByName;

  constructor(payload) {
    if (!record(payload) || payload.schemaVersion !== SKILL_TREE_SCHEMA_VERSION) {
      throw new Error('Unsupported skill-tree catalog schema');
    }
    requiredString(payload.game, 'Skill-tree game');
    requiredString(payload.installedBuild, 'Skill-tree installedBuild');
    if (!Array.isArray(payload.classes) || payload.classes.length !== 8) {
      throw new TypeError('Skill-tree catalog must contain eight classes');
    }
    this.#payload = freeze(clone(payload));
    this.#classes = new Map();
    this.#skillsById = new Map();
    this.#skillsByName = new Map();
    for (const entry of payload.classes) {
      if (!record(entry) || !CLASS_IDS.has(entry.id) || this.#classes.has(entry.id)) {
        throw new Error(`Invalid or duplicate skill-tree class: ${entry?.id}`);
      }
      if (!Array.isArray(entry.trees) || entry.trees.length !== 3 || !Array.isArray(entry.skills) || entry.skills.length !== 30) {
        throw new Error(`Skill-tree class ${entry.id} must contain three trees and 30 skills`);
      }
      const treePages = new Set(entry.trees.map((tree) => tree.page));
      if (treePages.size !== 3 || !treePages.has(1) || !treePages.has(2) || !treePages.has(3)) {
        throw new Error(`Skill-tree class ${entry.id} has invalid tree pages`);
      }
      const names = new Set();
      for (const skill of entry.skills) {
        requiredString(skill.id, `Skill id for ${entry.id}`);
        requiredString(skill.internalName, `Skill internalName for ${skill.id}`);
        if (this.#skillsById.has(skill.id) || names.has(skill.internalName)) throw new Error(`Duplicate skill ${skill.id}`);
        if (skill.treePage < 1 || skill.treePage > 3) throw new Error(`Invalid tree page for ${skill.id}`);
        if (!Number.isSafeInteger(skill.requirements?.characterLevel) || skill.requirements.characterLevel < 1) {
          throw new Error(`Invalid level requirement for ${skill.id}`);
        }
        nonNegativeInteger(skill.maximumBaseLevel, `Maximum level for ${skill.id}`);
        names.add(skill.internalName);
        this.#skillsById.set(skill.id, skill);
        this.#skillsByName.set(`${entry.id}:${skill.internalName}`, skill);
      }
      for (const skill of entry.skills) {
        for (const prerequisite of skill.requirements.prerequisiteSkills) {
          if (!names.has(prerequisite)) throw new Error(`Unknown prerequisite ${prerequisite} for ${skill.id}`);
        }
      }
      this.#classes.set(entry.id, entry);
    }
  }

  get installedBuild() { return this.#payload.installedBuild; }

  get sourceStatus() { return this.#payload.implementationPolicy; }

  classEntry(classId) {
    const entry = this.#classes.get(requiredString(classId, 'classId'));
    if (!entry) throw new Error(`Unknown skill-tree class: ${classId}`);
    return entry;
  }

  skill(classId, skillIdOrName) {
    const entry = this.classEntry(classId);
    const value = requiredString(skillIdOrName, 'skillId');
    const byId = this.#skillsById.get(value);
    if (byId && byId.id.startsWith(`${entry.id}.`)) return byId;
    const byName = this.#skillsByName.get(`${entry.id}:${value}`);
    if (byName) return byName;
    throw new Error(`Unknown skill ${value} for ${classId}`);
  }

  skillsForClass(classId) {
    return Object.freeze([...this.classEntry(classId).skills]);
  }

  treesForClass(classId) {
    return Object.freeze([...this.classEntry(classId).trees].sort((a, b) => a.page - b.page));
  }

  prerequisiteSkills(classId, skill) {
    const target = typeof skill === 'string' ? this.skill(classId, skill) : skill;
    return Object.freeze(target.requirements.prerequisiteSkills.map((name) => this.skill(classId, name)));
  }

  allocationCheck(character, skillIdOrName) {
    if (!record(character) || !CLASS_IDS.has(character.classId)) throw new TypeError('Character class is required');
    const skill = this.skill(character.classId, skillIdOrName);
    const state = skillState(character, skill);
    const reasons = [];
    if (!Number.isSafeInteger(character.unspentSkillPoints) || character.unspentSkillPoints < 1) reasons.push('Brak wolnych punktów umiejętności');
    const requiredLevel = skill.requirements.characterLevel + state.hardPoints;
    if (!Number.isSafeInteger(character.level) || character.level < requiredLevel) reasons.push(`Wymagany poziom ${requiredLevel} dla rangi ${state.hardPoints + 1}`);
    if (state.hardPoints >= skill.maximumBaseLevel) reasons.push(`Osiągnięto maksymalny poziom ${skill.maximumBaseLevel}`);
    for (const prerequisite of this.prerequisiteSkills(character.classId, skill)) {
      if ((character.skills?.[prerequisite.id]?.hardPoints ?? 0) < 1) {
        reasons.push(`Wymaga: ${prerequisite.localizedName?.plPL || prerequisite.internalName}`);
      }
    }
    return freeze({
      allowed: reasons.length === 0,
      reasons,
      skill,
      state,
    });
  }

  spendPoint(character, skillIdOrName) {
    const check = this.allocationCheck(character, skillIdOrName);
    if (!check.allowed) throw new Error(check.reasons.join('; '));
    const next = clone(character);
    next.unspentSkillPoints -= 1;
    const before = skillState(next, check.skill);
    next.skills[check.skill.id] = {
      hardPoints: before.hardPoints + 1,
      softPoints: before.softPoints,
      effectiveLevel: before.hardPoints + before.softPoints + 1,
    };
    character.unspentSkillPoints = next.unspentSkillPoints;
    character.skills[check.skill.id] = next.skills[check.skill.id];
    return freeze({
      skillId: check.skill.id,
      hardPoints: next.skills[check.skill.id].hardPoints,
      effectiveLevel: next.skills[check.skill.id].effectiveLevel,
      remainingPoints: next.unspentSkillPoints,
    });
  }

  view(character, page = 1) {
    const entry = this.classEntry(character.classId);
    if (!Number.isInteger(page) || page < 1 || page > 3) throw new RangeError('Tree page must be 1-3');
    const tree = entry.trees.find((candidate) => candidate.page === page);
    const skills = entry.skills.filter((skill) => skill.treePage === page).map((skill) => {
      const state = skillState(character, skill);
      const check = this.allocationCheck(character, skill.id);
      return {
        ...skill,
        state,
        unlocked: character.level >= skill.requirements.characterLevel
          && skill.requirements.prerequisiteSkills.every((name) => (character.skills?.[this.skill(entry.id, name).id]?.hardPoints ?? 0) > 0),
        allocatable: check.allowed,
        lockReasons: check.reasons,
      };
    }).sort((a, b) => a.position.row - b.position.row || a.position.column - b.position.column);
    return freeze({ classId: entry.id, tree, skills, remainingPoints: character.unspentSkillPoints });
  }
}

export function skillTreeCatalogFromAudit(payload) {
  return new SkillTreeCatalog(payload);
}
