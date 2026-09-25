import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { BATTLE_MUSIC_GAIN, DEFAULT_MUSIC_VOLUME, GameMusic, MUSIC_TRACKS, MUSIC_VOLUME_KEY } from "../app/game-music.js";

class FakeAudio {
  constructor(source) {
    this.source = source;
    this.paused = true;
    this.volume = 1;
    this.loop = false;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.blocked = false;
  }

  play() {
    this.playCalls += 1;
    if (this.blocked) return Promise.reject(new Error("Autoplay blocked"));
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

function harness({ storage = null } = {}) {
  const tracks = [];
  const frames = new Map();
  const clock = { time: 0, nextId: 1 };
  const music = new GameMusic({
    audioFactory: (source) => {
      const track = new FakeAudio(source);
      tracks.push(track);
      return track;
    },
    documentRef: new EventTarget(),
    storage,
    now: () => clock.time,
    requestFrame: (callback) => {
      const id = clock.nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
  });
  return {
    music,
    tracks,
    frames,
    advance(ms) {
      clock.time += ms;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("both supplied tracks are bundled at the module paths", () => {
  for (const source of Object.values(MUSIC_TRACKS)) {
    assert.ok(statSync(new URL(`../${source.slice(1)}`, import.meta.url)).size > 1_000_000);
  }
});

test("calm scenes share one looping track; combat crossfades and pauses the old track", async () => {
  const { music, tracks, advance } = harness();
  assert.equal(DEFAULT_MUSIC_VOLUME, 0.2);
  assert.deepEqual(tracks.map((track) => track.source), Object.values(MUSIC_TRACKS));
  assert.ok(tracks.every((track) => track.loop && track.preload === "auto"));
  music.setScene("menu");
  await Promise.resolve();
  advance(1200);
  assert.equal(tracks[0].volume, DEFAULT_MUSIC_VOLUME);
  music.setScene("camp");
  music.setScene("map");
  music.setScene("exploration");
  assert.equal(tracks[0].playCalls, 1);
  assert.equal(tracks[0].paused, false);
  assert.equal(tracks[0].volume, DEFAULT_MUSIC_VOLUME);
  assert.equal(tracks[1].paused, true);

  music.setScene("battle");
  await Promise.resolve();
  advance(600);
  assert.ok(Math.abs(tracks[0].volume - DEFAULT_MUSIC_VOLUME / 2) < 0.001);
  assert.ok(Math.abs(tracks[1].volume - DEFAULT_MUSIC_VOLUME * BATTLE_MUSIC_GAIN / 2) < 0.001);
  advance(600);
  assert.equal(tracks[0].paused, true);
  assert.equal(tracks[0].volume, 0);
  assert.equal(tracks[1].volume, DEFAULT_MUSIC_VOLUME * BATTLE_MUSIC_GAIN);
  assert.equal(music.getScene(), "battle");
  music.dispose();
});

test("fast scene changes fade from the current levels without leaving a stale track playing", async () => {
  const { music, tracks, advance } = harness();
  music.setScene("camp");
  await Promise.resolve();
  advance(1200);
  music.setScene("battle");
  await Promise.resolve();
  advance(400);
  const oldLevel = tracks[0].volume;
  music.setScene("map");
  await Promise.resolve();
  assert.equal(tracks[0].volume, oldLevel);
  advance(1200);
  assert.equal(tracks[0].volume, DEFAULT_MUSIC_VOLUME);
  assert.equal(tracks[1].volume, 0);
  assert.equal(tracks[1].paused, true);
  music.dispose();
});

test("blocked autoplay retries on a real user gesture", async () => {
  const { music, tracks, advance } = harness();
  tracks[0].blocked = true;
  music.setScene("menu");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(music.listeningForActivation, true);
  tracks[0].blocked = false;
  music.document.dispatchEvent(new Event("pointerdown"));
  await Promise.resolve();
  advance(1200);
  assert.equal(tracks[0].playCalls, 2);
  assert.equal(tracks[0].volume, DEFAULT_MUSIC_VOLUME);
  assert.equal(music.listeningForActivation, false);
  music.dispose();
});

test("volume is clamped, persisted independently of saves, and applied during a fade", async () => {
  const values = new Map([[MUSIC_VOLUME_KEY, "0.45"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const { music, tracks, advance } = harness({ storage });
  assert.equal(music.getVolume(), 0.45);
  music.setScene("battle");
  await Promise.resolve();
  advance(600);
  assert.ok(Math.abs(tracks[1].volume - 0.45 * BATTLE_MUSIC_GAIN / 2) < 0.001);
  assert.equal(music.setVolume(2), 1);
  assert.ok(Math.abs(tracks[1].volume - BATTLE_MUSIC_GAIN / 2) < 0.001);
  assert.equal(values.get(MUSIC_VOLUME_KEY), "1");
  assert.equal(music.setVolume(0), 0);
  assert.equal(tracks[1].volume, 0);
  assert.throws(() => music.setVolume("not a number"), RangeError);
  music.dispose();
});

test("saved preference remains authoritative while the battle track stays quieter", async () => {
  const values = new Map([[MUSIC_VOLUME_KEY, "0.5"]]);
  const { music, tracks, advance } = harness({ storage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  assert.equal(music.getVolume(), 0.5);
  music.setScene("menu");
  await Promise.resolve();
  advance(1200);
  assert.equal(tracks[0].volume, 0.5);
  music.setScene("battle");
  await Promise.resolve();
  advance(1200);
  assert.equal(tracks[1].volume, 0.5 * BATTLE_MUSIC_GAIN);
  assert.equal(values.get(MUSIC_VOLUME_KEY), "0.5");
  music.setScene("camp");
  await Promise.resolve();
  advance(1200);
  assert.equal(tracks[0].volume, 0.5);
  assert.equal(tracks[1].paused, true);
  music.dispose();
});
