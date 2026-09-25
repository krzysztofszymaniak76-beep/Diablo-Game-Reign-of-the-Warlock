import { MAX_PARTY_SIZE } from "./constants.js";

export class Party {
  constructor(roster, characterIds = []) {
    this.roster = roster;
    this.slots = [];
    for (const id of characterIds) this.add(id);
  }

  add(characterId) {
    if (this.slots.length >= MAX_PARTY_SIZE) throw new Error("Party is full");
    if (!this.roster.has(characterId)) throw new Error(`Character is not in roster: ${characterId}`);
    if (this.slots.includes(characterId)) throw new Error("Character is already active");
    const character = this.roster.get(characterId);
    if (character.hardcore && character.lifeState === "dead") throw new Error("A dead Hardcore character cannot join");
    this.slots.push(characterId);
  }

  indexOf(characterId) {
    return this.slots.indexOf(characterId);
  }

  replaceAt(slotIndex, incomingId) {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.slots.length) {
      throw new RangeError("Invalid occupied party slot");
    }
    if (!this.roster.has(incomingId)) throw new Error(`Character is not in roster: ${incomingId}`);
    if (this.slots.includes(incomingId)) throw new Error("Incoming character is already active");
    const incoming = this.roster.get(incomingId);
    if (incoming.hardcore && incoming.lifeState === "dead") throw new Error("A dead Hardcore character cannot return");
    const outgoingId = this.slots[slotIndex];
    this.slots[slotIndex] = incomingId;
    return outgoingId;
  }

  activeCharacters() {
    return this.slots.map((id) => this.roster.get(id));
  }

  isActive(characterId) {
    return this.slots.includes(characterId);
  }
}
