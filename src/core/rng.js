export class DeterministicRng {
  constructor(seed = 0x5a17c9e3) {
    this.state = seed >>> 0 || 1;
  }

  nextUint32() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  float() {
    return this.nextUint32() / 0x100000000;
  }

  integer(min, maxInclusive) {
    if (!Number.isInteger(min) || !Number.isInteger(maxInclusive) || maxInclusive < min) {
      throw new RangeError("Invalid integer range");
    }
    return min + Math.floor(this.float() * (maxInclusive - min + 1));
  }

  snapshot() {
    return { algorithm: "xorshift32", state: this.state };
  }

  static restore(snapshot) {
    if (snapshot?.algorithm !== "xorshift32" || !Number.isInteger(snapshot.state)) {
      throw new TypeError("Unsupported RNG snapshot");
    }
    if (snapshot.state < 1 || snapshot.state > 0xffffffff) {
      throw new RangeError("RNG snapshot state must be an exact non-zero uint32");
    }
    return new DeterministicRng(snapshot.state);
  }
}
