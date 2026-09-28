export class DamageEngine {
  constructor(rng) {
    this.rng = rng;
  }

  previewBasicAttack(profile) {
    const min = Math.max(0, Math.floor(profile.weaponMin + (profile.offWeaponFlat ?? 0)));
    const max = Math.max(min, Math.floor(profile.weaponMax + (profile.offWeaponFlat ?? 0)));
    return { min, max, damageType: profile.damageType ?? "physical",
      dataStatus: profile.status === 'SOURCE_NUMERIC_HEX_ADAPTATION' ? profile.status : "PLACEHOLDER_UNVERIFIED" };
  }

  resolveBasicAttack(profile) {
    const preview = this.previewBasicAttack(profile);
    return { ...preview, rolled: this.rng.integer(preview.min, preview.max) };
  }
}
