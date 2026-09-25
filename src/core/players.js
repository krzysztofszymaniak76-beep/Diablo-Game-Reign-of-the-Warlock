export class PlayersSetting {
  constructor(value = 1) {
    this.set(value);
  }

  set(value) {
    if (!Number.isInteger(value) || value < 1 || value > 8) throw new RangeError("/players must be 1-8");
    this.value = value;
  }

  get worldMultiplier() {
    return 1 + 0.5 * (this.value - 1);
  }

  scaleMonsterBase({ hp, experience }) {
    return {
      hp: Math.floor(hp * this.worldMultiplier),
      experience: Math.floor(experience * this.worldMultiplier),
      playersSnapshot: this.value,
    };
  }
}

export function parsePlayersCommand(text) {
  const match = /^\/players\s+([1-8])$/i.exec(String(text).trim());
  if (!match) return null;
  return Number(match[1]);
}
