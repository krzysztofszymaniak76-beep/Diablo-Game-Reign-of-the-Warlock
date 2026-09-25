export const PORTAL_SCHEMA_VERSION = 1;

export const PORTAL_STATUS = Object.freeze({
  ACTIVE: "active",
  CLOSED: "closed",
});

export const PORTAL_RESULT = Object.freeze({
  NO_SCROLL: "NO_TOWN_PORTAL_SCROLL",
  ILLEGAL_HEX: "ILLEGAL_PORTAL_HEX",
  PLACEMENT_VALIDATION_REQUIRED: "PORTAL_PLACEMENT_VALIDATION_REQUIRED",
  NOT_COMMAND_WINDOW: "NOT_OWNER_COMMAND_WINDOW",
  OWNER_NOT_ALIVE: "PORTAL_OWNER_NOT_ALIVE",
  PORTAL_NOT_ACTIVE: "PORTAL_NOT_ACTIVE",
  ENTRY_FORBIDDEN: "PORTAL_ENTRY_FORBIDDEN",
  CANNOT_REACH: "CANNOT_REACH_PORTAL",
  RESET_CONFIRMATION_REQUIRED: "RESET_CONFIRMATION_REQUIRED",
});

const RESET_CLOSE_POLICIES = new Set(["none", "owner", "source_instance", "all"]);
const ALL_HEROES_LEAVE_POLICIES = new Set(["suspend", "reset", "continue"]);
const ACCESS_POLICIES = new Set(["party", "owner", "listed"]);

function clone(value) {
  return structuredClone(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function resultFailure(code, message, extra = {}) {
  return { ok: false, code, reason: code, message, ...extra };
}

function normalizeHex(hex) {
  if (!hex || typeof hex !== "object") throw new TypeError("Portal source hex is required");
  const hasAxial = Number.isInteger(hex.q) && Number.isInteger(hex.r);
  const hasOffset = Number.isInteger(hex.x) && Number.isInteger(hex.y);
  if (!hasAxial && !hasOffset) throw new TypeError("Portal hex requires integer q/r or x/y coordinates");
  return clone(hex);
}

function normalizeSource(source) {
  if (!source || typeof source !== "object") throw new TypeError("Portal source is required");
  const normalized = {
    area_id: nonEmptyString(source.area_id ?? source.areaId, "Portal source area_id"),
    instance_id: nonEmptyString(source.instance_id ?? source.instanceId, "Portal source instance_id"),
    hex: normalizeHex(source.hex),
  };
  const worldId = source.world_id ?? source.worldId;
  const sectorId = source.sector_id ?? source.sectorId;
  if ((worldId === undefined) !== (sectorId === undefined)) {
    throw new TypeError("Portal exploration source requires both world_id and sector_id");
  }
  if (worldId !== undefined) {
    normalized.world_id = nonEmptyString(worldId, "Portal source world_id");
    normalized.sector_id = nonEmptyString(sectorId, "Portal source sector_id");
  }
  return normalized;
}

function hexKey(hex) {
  if (Number.isInteger(hex.q) && Number.isInteger(hex.r)) return `${hex.q},${hex.r}`;
  return `${hex.x},${hex.y}`;
}

function collectionHasHex(collection, hex) {
  if (!collection) return false;
  const key = hexKey(hex);
  if (collection instanceof Set || collection instanceof Map) {
    if (collection.has(key)) return true;
    for (const entry of collection.keys()) {
      if (entry && typeof entry === "object" && hexKey(entry) === key) return true;
    }
    return false;
  }
  if (Array.isArray(collection)) {
    return collection.some((entry) => {
      if (typeof entry === "string") return entry === key;
      const position = entry?.hex ?? entry?.position ?? entry;
      try { return hexKey(position) === key; } catch { return false; }
    });
  }
  return Boolean(collection[key]);
}

function normalizePlacementVerdict(verdict) {
  if (verdict === true) return { ok: true };
  if (verdict === false) return { ok: false, code: PORTAL_RESULT.ILLEGAL_HEX };
  if (verdict && typeof verdict === "object") {
    return verdict.ok === true || verdict.legal === true
      ? { ok: true }
      : { ok: false, code: verdict.code ?? verdict.reason ?? PORTAL_RESULT.ILLEGAL_HEX, message: verdict.message };
  }
  return { ok: false, code: PORTAL_RESULT.ILLEGAL_HEX };
}

/**
 * Validates a Town Portal destination against the authoritative battlefield.
 * A caller must provide either an explicit validator or battlefield occupancy
 * data; absence of both is deliberately not treated as a legal tile.
 */
export function validatePortalPlacement({ source, battlefield, isLegalHex, ownerCharacterId } = {}) {
  let normalized;
  try {
    normalized = normalizeSource(source);
  } catch (error) {
    return resultFailure(PORTAL_RESULT.ILLEGAL_HEX, error.message);
  }

  const context = { source: normalized, owner_character_id: ownerCharacterId };
  if (typeof isLegalHex === "function") {
    const verdict = normalizePlacementVerdict(isLegalHex(normalized.hex, context));
    return verdict.ok
      ? { ok: true, hex: clone(normalized.hex) }
      : resultFailure(verdict.code, verdict.message ?? "Town Portal cannot be placed on this hex");
  }
  if (typeof battlefield?.isLegalPortalHex === "function") {
    const verdict = normalizePlacementVerdict(battlefield.isLegalPortalHex(normalized.hex, context));
    return verdict.ok
      ? { ok: true, hex: clone(normalized.hex) }
      : resultFailure(verdict.code, verdict.message ?? "Town Portal cannot be placed on this hex");
  }
  if (typeof battlefield?.canPlacePortal === "function") {
    const verdict = normalizePlacementVerdict(battlefield.canPlacePortal(normalized.hex, context));
    return verdict.ok
      ? { ok: true, hex: clone(normalized.hex) }
      : resultFailure(verdict.code, verdict.message ?? "Town Portal cannot be placed on this hex");
  }

  if (!battlefield) {
    if (normalized.hex.portalLegal === true) return { ok: true, hex: clone(normalized.hex) };
    return resultFailure(
      PORTAL_RESULT.PLACEMENT_VALIDATION_REQUIRED,
      "Town Portal placement requires authoritative walkability and occupancy data",
    );
  }

  const hex = normalized.hex;
  if (typeof battlefield.containsHex === "function" && !battlefield.containsHex(hex)) {
    return resultFailure(PORTAL_RESULT.ILLEGAL_HEX, "Portal hex is outside the battlefield");
  }
  if (Number.isInteger(hex.x) && Number.isInteger(hex.y)
    && Number.isInteger(battlefield.width) && Number.isInteger(battlefield.height)
    && (hex.x < 0 || hex.y < 0 || hex.x >= battlefield.width || hex.y >= battlefield.height)) {
    return resultFailure(PORTAL_RESULT.ILLEGAL_HEX, "Portal hex is outside the battlefield");
  }

  const blockedCollections = [
    battlefield.blocked,
    battlefield.inaccessible,
    battlefield.occupied,
    battlefield.occupiedHexes,
    battlefield.largeUnitOccupiedHexes,
  ];
  if (blockedCollections.some((collection) => collectionHasHex(collection, hex))) {
    return resultFailure(PORTAL_RESULT.ILLEGAL_HEX, "Portal hex is blocked, inaccessible, or occupied");
  }
  if (Array.isArray(battlefield.units)) {
    const occupiedByUnit = battlefield.units.some((unit) => {
      if (unit?.removed || unit?.lifeState === "dead" || unit?.hp === 0) return false;
      return collectionHasHex(unit.occupiedHexes ?? unit.footprint ?? [unit.position], hex);
    });
    if (occupiedByUnit) return resultFailure(PORTAL_RESULT.ILLEGAL_HEX, "Portal hex is occupied by a unit");
  }
  if (battlefield.walkable && !collectionHasHex(battlefield.walkable, hex)) {
    return resultFailure(PORTAL_RESULT.ILLEGAL_HEX, "Portal hex is not walkable");
  }
  return { ok: true, hex: clone(hex) };
}

/** Serializable encounter policy. It intentionally contains no callbacks. */
export class EncounterRules {
  constructor({
    id = "standard",
    allowTownPortal = true,
    openingResetsEncounter = false,
    leavingAreaResetsEncounter = false,
    allHeroesLeave = "suspend",
    closePortalsOnReset = "none",
    closeOnOwnerReturn = true,
    access = "party",
    allowedCharacterIds = [],
    openingResetWarning = "Opening a Town Portal will reset this encounter.",
    leavingResetWarning = "Leaving this area will reset this encounter.",
    denialMessage = "Town Portals are not allowed by this encounter.",
  } = {}) {
    this.id = nonEmptyString(id, "Encounter rules id");
    this.allowTownPortal = Boolean(allowTownPortal);
    this.openingResetsEncounter = Boolean(openingResetsEncounter);
    this.leavingAreaResetsEncounter = Boolean(leavingAreaResetsEncounter);
    if (!ALL_HEROES_LEAVE_POLICIES.has(allHeroesLeave)) throw new RangeError(`Unknown allHeroesLeave policy: ${allHeroesLeave}`);
    if (!RESET_CLOSE_POLICIES.has(closePortalsOnReset)) throw new RangeError(`Unknown portal reset close policy: ${closePortalsOnReset}`);
    if (!ACCESS_POLICIES.has(access)) throw new RangeError(`Unknown portal access policy: ${access}`);
    this.allHeroesLeave = allHeroesLeave;
    this.closePortalsOnReset = closePortalsOnReset;
    this.closeOnOwnerReturn = Boolean(closeOnOwnerReturn);
    this.access = access;
    this.allowedCharacterIds = [...new Set(allowedCharacterIds.map((idValue) => nonEmptyString(idValue, "Allowed character id")))];
    this.openingResetWarning = String(openingResetWarning);
    this.leavingResetWarning = String(leavingResetWarning);
    this.denialMessage = String(denialMessage);
  }

  evaluateOpening({ confirmedReset = false } = {}) {
    if (!this.allowTownPortal) return resultFailure(PORTAL_RESULT.ENTRY_FORBIDDEN, this.denialMessage);
    if (this.openingResetsEncounter && !confirmedReset) {
      return resultFailure(PORTAL_RESULT.RESET_CONFIRMATION_REQUIRED, this.openingResetWarning, {
        warning: this.openingResetWarning,
        requiresConfirmation: true,
        encounterReset: true,
      });
    }
    return { ok: true, encounterReset: this.openingResetsEncounter };
  }

  evaluateLeaving({ isLastLivingHeroLeaving = false, confirmedReset = false } = {}) {
    const encounterReset = this.leavingAreaResetsEncounter
      || (isLastLivingHeroLeaving && this.allHeroesLeave === "reset");
    if (encounterReset && !confirmedReset) {
      return resultFailure(PORTAL_RESULT.RESET_CONFIRMATION_REQUIRED, this.leavingResetWarning, {
        warning: this.leavingResetWarning,
        requiresConfirmation: true,
        encounterReset: true,
      });
    }
    const disposition = encounterReset
      ? "reset"
      : (isLastLivingHeroLeaving ? this.allHeroesLeave : "continue");
    return { ok: true, encounterReset, encounterDisposition: disposition };
  }

  evaluateEntry({ characterId, ownerCharacterId } = {}) {
    if (this.access === "owner" && characterId !== ownerCharacterId) {
      return resultFailure(PORTAL_RESULT.ENTRY_FORBIDDEN, "Only the portal owner may use this portal");
    }
    if (this.access === "listed" && !this.allowedCharacterIds.includes(characterId)) {
      return resultFailure(PORTAL_RESULT.ENTRY_FORBIDDEN, "This character is not allowed to use the portal");
    }
    return { ok: true };
  }

  toJSON() {
    return clone({ ...this });
  }

  static fromJSON(data) {
    return data instanceof EncounterRules ? data : new EncounterRules(data);
  }

  static standard(overrides = {}) {
    return new EncounterRules(overrides);
  }

  static resettingEncounter(overrides = {}) {
    return new EncounterRules({
      id: "resetting_encounter",
      openingResetsEncounter: true,
      leavingAreaResetsEncounter: true,
      allHeroesLeave: "reset",
      ...overrides,
    });
  }
}

export class TownPortal {
  constructor({
    portal_id,
    portalId,
    owner_character_id,
    ownerCharacterId,
    source,
    destinationTown,
    campaignProfile,
    difficultyProfile,
    status = PORTAL_STATUS.ACTIVE,
    active,
    closeReason = null,
    encounterRules = new EncounterRules(),
  } = {}) {
    this.portal_id = nonEmptyString(portal_id ?? portalId, "portal_id");
    this.owner_character_id = nonEmptyString(owner_character_id ?? ownerCharacterId, "owner_character_id");
    this.source = normalizeSource(source);
    if (destinationTown === undefined || destinationTown === null || destinationTown === "") {
      throw new TypeError("destinationTown is required");
    }
    if (campaignProfile === undefined || campaignProfile === null) throw new TypeError("campaignProfile is required");
    if (difficultyProfile === undefined || difficultyProfile === null) throw new TypeError("difficultyProfile is required");
    this.destinationTown = clone(destinationTown);
    this.campaignProfile = clone(campaignProfile);
    this.difficultyProfile = clone(difficultyProfile);
    this.status = active === false ? PORTAL_STATUS.CLOSED : status;
    if (!Object.values(PORTAL_STATUS).includes(this.status)) throw new RangeError(`Unknown portal status: ${this.status}`);
    this.closeReason = this.status === PORTAL_STATUS.CLOSED ? (closeReason ?? "loaded_closed") : null;
    this.encounterRules = EncounterRules.fromJSON(encounterRules);
  }

  get portalId() { return this.portal_id; }
  get ownerCharacterId() { return this.owner_character_id; }
  get active() { return this.status === PORTAL_STATUS.ACTIVE; }
  get closed() { return this.status === PORTAL_STATUS.CLOSED; }

  close(reason = "closed") {
    if (this.closed) return false;
    this.status = PORTAL_STATUS.CLOSED;
    this.closeReason = reason;
    return true;
  }

  toJSON() {
    return clone({
      portal_id: this.portal_id,
      owner_character_id: this.owner_character_id,
      source: this.source,
      destinationTown: this.destinationTown,
      campaignProfile: this.campaignProfile,
      difficultyProfile: this.difficultyProfile,
      status: this.status,
      active: this.active,
      closed: this.closed,
      closeReason: this.closeReason,
      encounterRules: this.encounterRules.toJSON(),
    });
  }

  static fromJSON(data) {
    return data instanceof TownPortal ? data : new TownPortal(data);
  }
}

/**
 * A minimal scroll/tome stock with reservable use. Reservation makes portal
 * creation all-or-nothing: commit spends exactly one charge; rollback restores it.
 */
export class TownPortalScrollSupply {
  constructor(input = {}) {
    const values = typeof input === "number" ? { looseScrolls: input } : input;
    this.looseScrolls = values.looseScrolls ?? values.loose ?? 0;
    this.tomeScrolls = values.tomeScrolls ?? values.tome ?? 0;
    if (!Number.isSafeInteger(this.looseScrolls) || this.looseScrolls < 0) throw new RangeError("looseScrolls must be a non-negative safe integer");
    if (!Number.isSafeInteger(this.tomeScrolls) || this.tomeScrolls < 0) throw new RangeError("tomeScrolls must be a non-negative safe integer");
  }

  get remaining() { return this.looseScrolls + this.tomeScrolls; }
  get count() { return this.remaining; }

  reserveOne() {
    const source = this.tomeScrolls > 0 ? "tomeScrolls" : (this.looseScrolls > 0 ? "looseScrolls" : null);
    if (!source) return null;
    this[source] -= 1;
    let settled = false;
    return {
      source,
      commit() {
        if (settled) throw new Error("Town Portal scroll reservation is already settled");
        settled = true;
      },
      rollback: () => {
        if (settled) return false;
        this[source] += 1;
        settled = true;
        return true;
      },
    };
  }

  toJSON() {
    return { looseScrolls: this.looseScrolls, tomeScrolls: this.tomeScrolls };
  }

  static fromJSON(data) {
    return new TownPortalScrollSupply(data);
  }
}

function reserveScroll(supply) {
  if (!supply) return null;
  if (typeof supply.reserveOne === "function") return supply.reserveOne();
  if (typeof supply.reserveTownPortalScroll === "function") return supply.reserveTownPortalScroll();

  const property = ["tomeScrolls", "townPortalScrolls", "scrolls", "charges", "count"]
    .find((keyName) => Number.isSafeInteger(supply[keyName]) && supply[keyName] > 0);
  if (!property) return null;
  const descriptor = Object.getOwnPropertyDescriptor(supply, property);
  if (descriptor && !descriptor.writable && !descriptor.set) {
    throw new TypeError("Scroll supply count must be writable or expose reserveOne()");
  }
  supply[property] -= 1;
  let settled = false;
  return {
    source: property,
    commit() { settled = true; },
    rollback() {
      if (settled) return false;
      supply[property] += 1;
      settled = true;
      return true;
    },
  };
}

function actorIdOf(value) {
  if (typeof value === "string") return value;
  return value?.id ?? value?.character_id ?? value?.characterId ?? null;
}

function actorIsAlive(value, explicitAlive) {
  if (explicitAlive !== undefined) return Boolean(explicitAlive);
  if (!value || typeof value === "string") return true;
  if (value.alive === false || value.lifeState && value.lifeState !== "alive") return false;
  if (value.resources && Number(value.resources.hp) <= 0) return false;
  if (value.hp !== undefined && Number(value.hp) <= 0) return false;
  return true;
}

function normalizeRules(rules) {
  return EncounterRules.fromJSON(rules ?? {});
}

function normalizedPortalId(input) {
  return input.portal_id ?? input.portalId;
}

function normalizedCharacterId(input) {
  return input.character_id ?? input.characterId ?? actorIdOf(input.character);
}

function rewardsNone() {
  return { experience: 0, loot: [], victory: false, questRewards: [] };
}

function followerId(follower) {
  return typeof follower === "string" ? follower : follower?.id;
}

function followerPolicy(follower) {
  if (typeof follower === "string") return "follow";
  if (["follow", "stay", "dismiss"].includes(follower?.portalPolicy)) return follower.portalPolicy;
  if (follower?.canUseTownPortal === false || follower?.followsOwnerThroughPortal === false) return "stay";
  if (follower?.persistsOnTownTravel === false) return "dismiss";
  return "follow";
}

function normalizeMember(member) {
  return { id: actorIdOf(member), value: member, alive: actorIsAlive(member) };
}

export class PortalSystem {
  constructor({
    portals = [],
    locations = [],
    transitionLog = [],
    nextPortalSequence = 1,
    idFactory = null,
    placementValidator = null,
  } = {}) {
    if (!Array.isArray(portals)) throw new TypeError("portals must be an array");
    if (!Array.isArray(transitionLog)) throw new TypeError("transitionLog must be an array");
    if (!Array.isArray(locations) && (locations === null || typeof locations !== "object")) {
      throw new TypeError("locations must be an array or object");
    }
    if (!Number.isSafeInteger(nextPortalSequence)
      || nextPortalSequence < 0
      || nextPortalSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("nextPortalSequence must be a non-negative, non-exhausted safe integer");
    }
    this.portals = new Map();
    this.activePortalByOwner = new Map();
    this.locations = new Map(Array.isArray(locations) ? locations.map(([id, location]) => [id, clone(location)]) : Object.entries(locations));
    this.transitionLog = clone(transitionLog);
    this.nextPortalSequence = nextPortalSequence;
    this.idFactory = idFactory;
    this.placementValidator = placementValidator;
    for (const portalData of portals) {
      const portal = TownPortal.fromJSON(portalData);
      if (this.portals.has(portal.portal_id)) throw new Error(`Duplicate portal id: ${portal.portal_id}`);
      if (portal.active && this.activePortalByOwner.has(portal.owner_character_id)) {
        throw new Error(`Multiple active portals for owner: ${portal.owner_character_id}`);
      }
      this.portals.set(portal.portal_id, portal);
      if (portal.active) this.activePortalByOwner.set(portal.owner_character_id, portal.portal_id);
    }
  }

  #nextPortalId() {
    if (this.idFactory) return nonEmptyString(this.idFactory(), "Generated portal id");
    let id;
    do {
      if (!Number.isSafeInteger(this.nextPortalSequence)
        || this.nextPortalSequence < 0
        || this.nextPortalSequence >= Number.MAX_SAFE_INTEGER - 1) {
        throw new RangeError("Portal id sequence is exhausted or invalid");
      }
      id = `town-portal-${this.nextPortalSequence}`;
      this.nextPortalSequence += 1;
    } while (this.portals.has(id));
    return id;
  }

  getPortal(portalId) {
    return this.portals.get(portalId) ?? null;
  }

  getActivePortalForOwner(ownerCharacterId) {
    const id = this.activePortalByOwner.get(ownerCharacterId);
    return id ? this.getPortal(id) : null;
  }

  listActivePortals() {
    return [...this.activePortalByOwner.values()].map((id) => this.portals.get(id));
  }

  locationOf(characterId) {
    const location = this.locations.get(characterId);
    return location ? clone(location) : null;
  }

  setCharacterLocation(characterId, location) {
    this.locations.set(nonEmptyString(characterId, "Character id"), clone(location));
  }

  closePortal(portalId, reason = "closed") {
    const portal = this.getPortal(portalId);
    if (!portal) return false;
    const changed = portal.close(reason);
    if (this.activePortalByOwner.get(portal.owner_character_id) === portalId) {
      this.activePortalByOwner.delete(portal.owner_character_id);
    }
    return changed;
  }

  #closeForReset(rules, source, ownerCharacterId) {
    if (rules.closePortalsOnReset === "none") return [];
    const closed = [];
    for (const portal of this.portals.values()) {
      if (!portal.active) continue;
      const matches = rules.closePortalsOnReset === "all"
        || (rules.closePortalsOnReset === "owner" && portal.owner_character_id === ownerCharacterId)
        || (rules.closePortalsOnReset === "source_instance" && portal.source.instance_id === source.instance_id);
      if (matches && this.closePortal(portal.portal_id, "encounter_reset")) closed.push(portal.portal_id);
    }
    return closed;
  }

  openPortal(input = {}) {
    const owner = input.owner ?? input.character;
    const ownerCharacterId = input.owner_character_id ?? input.ownerCharacterId ?? actorIdOf(owner);
    if (!ownerCharacterId) throw new TypeError("owner_character_id is required");
    if (!actorIsAlive(owner, input.ownerAlive)) {
      return resultFailure(PORTAL_RESULT.OWNER_NOT_ALIVE, "Only a living character can open a Town Portal");
    }
    const actingId = input.acting_character_id ?? input.actingCharacterId;
    if (input.commandWindow === false || input.actionResolving === true || (actingId && actingId !== ownerCharacterId)) {
      return resultFailure(PORTAL_RESULT.NOT_COMMAND_WINDOW, "Town Portal must be opened in its owner's legal command window");
    }

    let source;
    try { source = normalizeSource(input.source); } catch (error) {
      return resultFailure(PORTAL_RESULT.ILLEGAL_HEX, error.message);
    }
    const placement = validatePortalPlacement({
      source,
      battlefield: input.battlefield,
      isLegalHex: input.isLegalHex ?? this.placementValidator,
      ownerCharacterId,
    });
    if (!placement.ok) return placement;

    const rules = normalizeRules(input.encounterRules);
    const ruleVerdict = rules.evaluateOpening({ confirmedReset: input.confirmReset === true });
    if (!ruleVerdict.ok) return ruleVerdict;

    let portal;
    try {
      portal = new TownPortal({
        portal_id: normalizedPortalId(input) ?? this.#nextPortalId(),
        owner_character_id: ownerCharacterId,
        source,
        destinationTown: input.destinationTown,
        campaignProfile: input.campaignProfile,
        difficultyProfile: input.difficultyProfile,
        encounterRules: rules,
      });
    } catch (error) {
      return resultFailure("INVALID_PORTAL_DATA", error.message);
    }
    if (this.portals.has(portal.portal_id)) return resultFailure("DUPLICATE_PORTAL_ID", `Duplicate portal id: ${portal.portal_id}`);

    let reservation;
    try { reservation = reserveScroll(input.scrollSupply); } catch (error) {
      return resultFailure("INVALID_SCROLL_SUPPLY", error.message);
    }
    if (!reservation) return resultFailure(PORTAL_RESULT.NO_SCROLL, "No Town Portal scroll remains");

    const previousActive = new Map(this.activePortalByOwner);
    const previousLogLength = this.transitionLog.length;
    const previousStates = [...this.portals.values()].map((item) => ({ item, status: item.status, closeReason: item.closeReason }));
    const previousOwnPortal = this.getActivePortalForOwner(ownerCharacterId);
    const replacedPortalId = previousOwnPortal?.portal_id ?? null;
    let undoReset = null;
    try {
      if (ruleVerdict.encounterReset && typeof input.onEncounterReset === "function") {
        const possibleUndo = input.onEncounterReset({
          cause: "town_portal_opened",
          source: clone(source),
          owner_character_id: ownerCharacterId,
          rules: rules.toJSON(),
        });
        if (typeof possibleUndo === "function") undoReset = possibleUndo;
      }
      const closedByReset = ruleVerdict.encounterReset
        ? this.#closeForReset(rules, source, ownerCharacterId)
        : [];
      if (previousOwnPortal?.active) this.closePortal(previousOwnPortal.portal_id, "replaced_by_owner");
      this.portals.set(portal.portal_id, portal);
      this.activePortalByOwner.set(ownerCharacterId, portal.portal_id);
      this.transitionLog.push({
        kind: "portal_opened",
        portal_id: portal.portal_id,
        owner_character_id: ownerCharacterId,
        encounterReset: ruleVerdict.encounterReset,
      });
      reservation.commit?.();
      return {
        ok: true,
        portal,
        replacedPortalId,
        closedByReset,
        scrollsConsumed: 1,
        encounterReset: ruleVerdict.encounterReset,
        combatWasActive: Boolean(input.hasLivingEnemies),
      };
    } catch (error) {
      this.portals.delete(portal.portal_id);
      this.activePortalByOwner = previousActive;
      this.transitionLog.length = previousLogLength;
      for (const state of previousStates) {
        state.item.status = state.status;
        state.item.closeReason = state.closeReason;
      }
      try { undoReset?.(); } catch { /* caller's undo failed; scroll is still restored */ }
      reservation.rollback?.();
      return resultFailure("PORTAL_TRANSACTION_FAILED", error.message);
    }
  }

  #activePortalOrFailure(portalId) {
    const portal = this.getPortal(portalId);
    if (!portal?.active) {
      return { portal: null, failure: resultFailure(PORTAL_RESULT.PORTAL_NOT_ACTIVE, "Town Portal is closed or does not exist") };
    }
    return { portal, failure: null };
  }

  #moveFollowers(followers, location, ownerCharacterId) {
    const movedFollowerIds = [];
    const leftBehindFollowerIds = [];
    const dismissedFollowerIds = [];
    const seen = new Set();
    for (const follower of followers ?? []) {
      const id = followerId(follower);
      if (!id || id === ownerCharacterId || seen.has(id)) continue;
      seen.add(id);
      if (!actorIsAlive(follower)) {
        leftBehindFollowerIds.push(id);
        continue;
      }
      const policy = followerPolicy(follower);
      if (policy === "stay") {
        leftBehindFollowerIds.push(id);
      } else if (policy === "dismiss") {
        this.locations.set(id, { kind: "dismissed", owner_character_id: ownerCharacterId, reason: "town_portal_policy" });
        dismissedFollowerIds.push(id);
      } else {
        this.locations.set(id, clone(location));
        movedFollowerIds.push(id);
      }
    }
    return { movedFollowerIds, leftBehindFollowerIds, dismissedFollowerIds };
  }

  enterTown(input = {}) {
    const portalId = normalizedPortalId(input);
    const { portal, failure } = this.#activePortalOrFailure(portalId);
    if (failure) return failure;
    const character = input.character;
    const characterId = normalizedCharacterId(input);
    if (!characterId) throw new TypeError("character_id is required");
    if (!actorIsAlive(character, input.characterAlive)) {
      return resultFailure(PORTAL_RESULT.OWNER_NOT_ALIVE, "A dead character cannot enter town as a living traveler");
    }
    const entryVerdict = portal.encounterRules.evaluateEntry({
      characterId,
      ownerCharacterId: portal.owner_character_id,
    });
    if (!entryVerdict.ok) return entryVerdict;
    if (typeof input.canReachPortal === "function" && !input.canReachPortal(character ?? characterId, portal)) {
      return resultFailure(PORTAL_RESULT.CANNOT_REACH, "Character cannot reach the Town Portal");
    }
    const currentLocation = this.locations.get(characterId);
    if (currentLocation?.kind === "area" && currentLocation.instance_id !== portal.source.instance_id) {
      return resultFailure(PORTAL_RESULT.CANNOT_REACH, "Character is in a different area instance");
    }

    const leaveVerdict = portal.encounterRules.evaluateLeaving({
      isLastLivingHeroLeaving: input.isLastLivingHeroLeaving === true,
      confirmedReset: input.confirmReset === true,
    });
    if (!leaveVerdict.ok) return leaveVerdict;

    const previousLocations = new Map(this.locations);
    const previousActive = new Map(this.activePortalByOwner);
    const previousStates = [...this.portals.values()].map((item) => ({ item, status: item.status, closeReason: item.closeReason }));
    try {
      if (leaveVerdict.encounterReset && typeof input.onEncounterReset === "function") {
        input.onEncounterReset({
          cause: "character_left_area",
          source: clone(portal.source),
          character_id: characterId,
          rules: portal.encounterRules.toJSON(),
        });
      }
      const townLocation = {
        kind: "town",
        town_id: clone(portal.destinationTown),
        via_portal_id: portal.portal_id,
        source_instance_id: portal.source.instance_id,
      };
      this.locations.set(characterId, townLocation);
      const followerResult = this.#moveFollowers(input.followers, townLocation, characterId);
      const closedByReset = leaveVerdict.encounterReset
        ? this.#closeForReset(portal.encounterRules, portal.source, portal.owner_character_id)
        : [];
      const transition = {
        kind: "entered_town",
        character_id: characterId,
        portal_id: portal.portal_id,
        from: clone(portal.source),
        to: clone(townLocation),
      };
      this.transitionLog.push(transition);
      return {
        ok: true,
        transition,
        ...followerResult,
        rewards: rewardsNone(),
        encounterReset: leaveVerdict.encounterReset,
        encounterDisposition: leaveVerdict.encounterDisposition,
        closedByReset,
      };
    } catch (error) {
      this.locations = previousLocations;
      this.activePortalByOwner = previousActive;
      for (const state of previousStates) {
        state.item.status = state.status;
        state.item.closeReason = state.closeReason;
      }
      return resultFailure("TOWN_ENTRY_FAILED", error.message);
    }
  }

  returnThroughPortal(input = {}) {
    const portalId = normalizedPortalId(input);
    const { portal, failure } = this.#activePortalOrFailure(portalId);
    if (failure) return failure;
    const character = input.character;
    const characterId = normalizedCharacterId(input);
    if (!characterId) throw new TypeError("character_id is required");
    if (!actorIsAlive(character, input.characterAlive)) {
      return resultFailure(PORTAL_RESULT.OWNER_NOT_ALIVE, "A dead character cannot return as a living traveler");
    }
    const entryVerdict = portal.encounterRules.evaluateEntry({
      characterId,
      ownerCharacterId: portal.owner_character_id,
    });
    if (!entryVerdict.ok) return entryVerdict;

    const sourceLocation = {
      kind: "area",
      area_id: portal.source.area_id,
      instance_id: portal.source.instance_id,
      hex: clone(portal.source.hex),
      via_portal_id: portal.portal_id,
    };
    this.locations.set(characterId, sourceLocation);
    const followerResult = this.#moveFollowers(input.followers, sourceLocation, characterId);
    const closesPortal = characterId === portal.owner_character_id && portal.encounterRules.closeOnOwnerReturn;
    if (closesPortal) this.closePortal(portal.portal_id, "owner_returned_to_source");
    const transition = {
      kind: "returned_to_source",
      character_id: characterId,
      portal_id: portal.portal_id,
      to: clone(sourceLocation),
    };
    this.transitionLog.push(transition);
    return {
      ok: true,
      transition,
      ...followerResult,
      rewards: rewardsNone(),
      portalClosed: closesPortal,
    };
  }

  #membersOwnerLast(members, ownerCharacterId) {
    return [
      ...members.filter((member) => member.id !== ownerCharacterId),
      ...members.filter((member) => member.id === ownerCharacterId),
    ];
  }

  partyToPortal(input = {}) {
    const portalId = normalizedPortalId(input);
    const { portal, failure } = this.#activePortalOrFailure(portalId);
    if (failure) return failure;
    const members = (input.characters ?? input.characterIds ?? []).map(normalizeMember);
    if (members.some((member) => !member.id)) throw new TypeError("Every party member requires an id");
    const alive = members.filter((member) => member.alive);
    const dead = members.filter((member) => !member.alive).map((member) => member.id);
    const reachable = [];
    const unreachable = [];
    for (const member of alive) {
      if (typeof input.canReachPortal === "function" && !input.canReachPortal(member.value, portal)) unreachable.push(member.id);
      else reachable.push(member);
    }
    const order = this.#membersOwnerLast(reachable, portal.owner_character_id);
    if (input.allLivingHeroesLeaving === true && order.length) {
      const preflight = portal.encounterRules.evaluateLeaving({
        isLastLivingHeroLeaving: true,
        confirmedReset: input.confirmReset === true,
      });
      if (!preflight.ok) return { ...preflight, reachable: order.map((member) => member.id), unreachable, dead };
    }

    const entered = [];
    const transitions = [];
    for (let index = 0; index < order.length; index += 1) {
      const member = order[index];
      const followers = typeof input.followersByOwner === "function"
        ? input.followersByOwner(member.id)
        : (input.followersByOwner?.get?.(member.id) ?? input.followersByOwner?.[member.id] ?? []);
      const outcome = this.enterTown({
        portal_id: portalId,
        character_id: member.id,
        character: member.value,
        followers,
        isLastLivingHeroLeaving: input.allLivingHeroesLeaving === true && index === order.length - 1,
        confirmReset: input.confirmReset,
        onEncounterReset: input.onEncounterReset,
      });
      if (!outcome.ok) {
        unreachable.push(member.id);
        continue;
      }
      entered.push(member.id);
      transitions.push(outcome.transition);
    }
    return {
      ok: true,
      traversalOrder: order.map((member) => member.id),
      entered,
      inTown: entered,
      unableToEnter: [...dead, ...unreachable],
      dead,
      unreachable,
      remainingOnBattlefield: members.map((member) => member.id).filter((id) => !entered.includes(id)),
      transitions,
      rewards: rewardsNone(),
    };
  }

  returnPartyThroughPortal(input = {}) {
    const portalId = normalizedPortalId(input);
    const { portal, failure } = this.#activePortalOrFailure(portalId);
    if (failure) return failure;
    const members = (input.characters ?? input.characterIds ?? []).map(normalizeMember);
    if (members.some((member) => !member.id)) throw new TypeError("Every party member requires an id");
    const dead = members.filter((member) => !member.alive).map((member) => member.id);
    const alive = members.filter((member) => member.alive);
    for (const member of alive) {
      const verdict = portal.encounterRules.evaluateEntry({
        characterId: member.id,
        ownerCharacterId: portal.owner_character_id,
      });
      if (!verdict.ok) return { ...verdict, characterId: member.id };
    }
    const order = this.#membersOwnerLast(alive, portal.owner_character_id);
    const returned = [];
    const transitions = [];
    for (const member of order) {
      const followers = typeof input.followersByOwner === "function"
        ? input.followersByOwner(member.id)
        : (input.followersByOwner?.get?.(member.id) ?? input.followersByOwner?.[member.id] ?? []);
      const outcome = this.returnThroughPortal({
        portal_id: portalId,
        character_id: member.id,
        character: member.value,
        followers,
      });
      if (!outcome.ok) return { ...outcome, returned, traversalOrder: order.map((memberValue) => memberValue.id) };
      returned.push(member.id);
      transitions.push(outcome.transition);
    }
    return {
      ok: true,
      traversalOrder: order.map((member) => member.id),
      returned,
      dead,
      transitions,
      portalClosed: !portal.active,
      rewards: rewardsNone(),
    };
  }

  toJSON() {
    return clone({
      schemaVersion: PORTAL_SCHEMA_VERSION,
      nextPortalSequence: this.nextPortalSequence,
      portals: [...this.portals.values()].map((portal) => portal.toJSON()),
      locations: [...this.locations.entries()],
      transitionLog: this.transitionLog,
    });
  }

  static fromJSON(data, options = {}) {
    if (data?.schemaVersion !== PORTAL_SCHEMA_VERSION) {
      throw new Error(`Unsupported portal save schema: ${data?.schemaVersion}`);
    }
    return new PortalSystem({
      portals: data.portals,
      locations: data.locations,
      transitionLog: data.transitionLog,
      nextPortalSequence: data.nextPortalSequence,
      idFactory: options.idFactory,
      placementValidator: options.placementValidator,
    });
  }
}
