// Music playback is deliberately independent of the game's save data and turn clock.
export const MUSIC_TRACKS = Object.freeze({
  calm: "/app/assets/music/diablo-intro.mp3",
  battle: "/app/assets/music/diablo-walka.mp3",
});

export const MUSIC_VOLUME_KEY = "rotw.music.volume.v1";
export const DEFAULT_MUSIC_VOLUME = 0.2;
export const BATTLE_MUSIC_GAIN = 0.8;

const SCENE_TRACK = Object.freeze({
  menu: "calm",
  camp: "calm",
  map: "calm",
  exploration: "calm",
  battle: "battle",
});

function availableStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

function storedVolume(storage) {
  try {
    const raw = storage?.getItem(MUSIC_VOLUME_KEY);
    if (raw !== null && raw !== undefined && raw !== "") {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
    }
  } catch { /* Private browsing and storage policy must not stop the music. */ }
  return DEFAULT_MUSIC_VOLUME;
}

export class GameMusic {
  constructor({
    audioFactory = (source) => new Audio(source),
    documentRef = globalThis.document,
    storage = availableStorage(),
    fadeMs = 1200,
    now = () => performance.now(),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
  } = {}) {
    if (!Number.isFinite(fadeMs) || fadeMs < 0) throw new RangeError("fadeMs must be non-negative");
    this.document = documentRef;
    this.storage = storage;
    this.fadeMs = fadeMs;
    this.now = now;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.volume = storedVolume(storage);
    this.scene = null;
    this.target = null;
    this.levels = { calm: 0, battle: 0 };
    this.frame = null;
    this.requestId = 0;
    this.listeningForActivation = false;
    this.disposed = false;
    this.onActivation = () => this.unlock();
    this.audio = Object.fromEntries(Object.entries(MUSIC_TRACKS).map(([key, source]) => {
      const track = audioFactory(source);
      track.loop = true;
      track.preload = "auto";
      track.volume = 0;
      return [key, track];
    }));
  }

  getVolume() { return this.volume; }
  getScene() { return this.scene; }

  setVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new RangeError("Music volume must be a number");
    this.volume = Math.max(0, Math.min(1, number));
    this.applyVolumes();
    try { this.storage?.setItem(MUSIC_VOLUME_KEY, String(this.volume)); } catch { /* Optional persistence. */ }
    return this.volume;
  }

  setScene(scene) {
    if (!(scene in SCENE_TRACK)) throw new RangeError(`Unknown music scene: ${scene}`);
    if (this.disposed) return;
    const target = SCENE_TRACK[scene];
    this.scene = scene;
    if (this.target === target && !this.audio[target].paused) return;
    this.target = target;
    this.requestId += 1;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.listenForActivation();
    this.playTarget(this.requestId, target);
  }

  // May also be called directly from a Start / Continue button's click handler.
  unlock() {
    if (this.disposed || !this.target) return;
    this.requestId += 1;
    this.playTarget(this.requestId, this.target);
  }

  playTarget(requestId, target) {
    const track = this.audio[target];
    let result;
    try { result = track.play(); }
    catch { this.listenForActivation(); return; }
    Promise.resolve(result).then(() => {
      if (this.disposed || requestId !== this.requestId) {
        if (target !== this.target || this.disposed) track.pause();
        return;
      }
      this.stopListeningForActivation();
      this.startFade(target);
    }).catch(() => {
      if (!this.disposed && requestId === this.requestId) this.listenForActivation();
    });
  }

  startFade(target) {
    if (this.frame !== null) this.cancelFrame(this.frame);
    const start = this.now();
    const from = { ...this.levels };
    const step = () => {
      if (this.disposed) return;
      const progress = this.fadeMs === 0 ? 1 : Math.min(1, Math.max(0, (this.now() - start) / this.fadeMs));
      // Smoothstep avoids an abrupt change in slope at either end of a fade.
      const blend = progress * progress * (3 - 2 * progress);
      for (const key of Object.keys(this.levels)) {
        this.levels[key] = from[key] + ((key === target ? 1 : 0) - from[key]) * blend;
      }
      this.applyVolumes();
      if (progress < 1) {
        this.frame = this.requestFrame(step);
      } else {
        this.frame = null;
        for (const [key, track] of Object.entries(this.audio)) {
          if (key !== target) track.pause();
        }
      }
    };
    step();
  }

  applyVolumes() {
    for (const [key, track] of Object.entries(this.audio)) {
      const sceneGain = key === "battle" ? BATTLE_MUSIC_GAIN : 1;
      track.volume = Math.max(0, Math.min(1, this.levels[key] * this.volume * sceneGain));
    }
  }

  listenForActivation() {
    if (!this.document || this.listeningForActivation) return;
    this.document.addEventListener("pointerdown", this.onActivation, { capture: true });
    this.document.addEventListener("keydown", this.onActivation, { capture: true });
    this.listeningForActivation = true;
  }

  stopListeningForActivation() {
    if (!this.document || !this.listeningForActivation) return;
    this.document.removeEventListener("pointerdown", this.onActivation, { capture: true });
    this.document.removeEventListener("keydown", this.onActivation, { capture: true });
    this.listeningForActivation = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.requestId += 1;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.stopListeningForActivation();
    for (const track of Object.values(this.audio)) {
      track.pause();
      track.volume = 0;
    }
  }
}
