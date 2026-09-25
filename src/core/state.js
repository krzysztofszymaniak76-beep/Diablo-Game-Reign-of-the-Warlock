import { Roster } from "./characters.js";
import { Party } from "./party.js";
import { CampaignState } from "./campaign.js";
import { PlayersSetting } from "./players.js";
import { ItemLedger } from "./inventory.js";

export const SAVE_SCHEMA_VERSION = 1;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSettings(settings) {
  if (!plainObject(settings)) throw new TypeError("Save settings must be an object");
  if (!Number.isFinite(settings.uiScale) || settings.uiScale < 0.5 || settings.uiScale > 2) {
    throw new RangeError("Save uiScale must be between 0.5 and 2");
  }
  if (typeof settings.reducedFlashes !== "boolean") throw new TypeError("Save reducedFlashes must be a boolean");
  for (const field of ["music", "effects"]) {
    if (!Number.isFinite(settings[field]) || settings[field] < 0 || settings[field] > 1) {
      throw new RangeError(`Save ${field} must be between 0 and 1`);
    }
  }
}

export class GameState {
  constructor({ roster = new Roster(), partyIds = [], campaign = new CampaignState(), players = 1, items = [] } = {}) {
    this.roster = roster;
    this.party = new Party(roster, partyIds);
    this.campaign = campaign;
    this.players = new PlayersSetting(players);
    this.items = new ItemLedger(items);
    this.settings = { uiScale: 1, reducedFlashes: false, music: 0.6, effects: 0.8 };
  }

  serialize() {
    return {
      schemaVersion: SAVE_SCHEMA_VERSION,
      roster: this.roster.toJSON(),
      partyIds: [...this.party.slots],
      campaign: this.campaign.toJSON(),
      players: this.players.value,
      items: this.items.toJSON(),
      settings: structuredClone(this.settings),
    };
  }

  static deserialize(data) {
    if (data?.schemaVersion !== SAVE_SCHEMA_VERSION) throw new Error(`Unsupported save schema: ${data?.schemaVersion}`);
    if (!Array.isArray(data.roster) || data.roster.length === 0) throw new TypeError("Save roster must be a non-empty array");
    if (!Array.isArray(data.partyIds) || data.partyIds.length === 0 || data.partyIds.length > 3
      || new Set(data.partyIds).size !== data.partyIds.length) {
      throw new TypeError("Save party must contain 1-3 unique character ids");
    }
    if (!plainObject(data.campaign)) throw new TypeError("Save campaign must be an object");
    if (!Number.isInteger(data.campaign.worldSeed)
      || data.campaign.worldSeed < 0
      || data.campaign.worldSeed > 0xffffffff) {
      throw new RangeError("Campaign worldSeed must be an exact uint32");
    }
    if (!Array.isArray(data.campaign.unlockedActs)
      || data.campaign.unlockedActs.some((act) => !Number.isInteger(act) || act < 1 || act > 5)
      || !Array.isArray(data.campaign.unlockedDifficulties)
      || !plainObject(data.campaign.waypoints)
      || !plainObject(data.campaign.questState)) {
      throw new TypeError("Save campaign progression is malformed");
    }
    if (!Array.isArray(data.items)) throw new TypeError("Save items must be an array");
    validateSettings(data.settings);
    const roster = new Roster(data.roster);
    const campaign = CampaignState.restoreAct1(data.campaign);
    const game = new GameState({ roster, partyIds: data.partyIds, campaign, players: data.players, items: data.items });
    for (const item of game.items.toJSON()) {
      if (!roster.has(item.location.ownerId)) {
        throw new Error(`Item owner is not present in the roster: ${item.id}`);
      }
    }
    game.settings = structuredClone(data.settings);
    return game;
  }
}
