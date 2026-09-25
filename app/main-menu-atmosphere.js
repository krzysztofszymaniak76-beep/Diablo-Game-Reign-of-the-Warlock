// The approved illustration is the static background. Animated elements stay
// within hand-picked sky and lava masks; characters and scenery never move.
const SCENE_WIDTH = 1690;
const SCENE_HEIGHT = 964;
const FRAME_MS = 1000 / 30;
const MAX_PIXELS = 2_300_000;
const TAU = Math.PI * 2;

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function smoothstep(start, end, value) {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

function interpolateBand(y, stops, column) {
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (y <= next[0]) {
      const fraction = (y - previous[0]) / (next[0] - previous[0]);
      return previous[column] + (next[column] - previous[column]) * fraction;
    }
  }
  return stops.at(-1)[column];
}

// Original-image coordinates. The band follows the bright fissure, not its
// rectangular crop. It deliberately stays to the right of the foreground hero.
const lavaBounds = { x: 1145, y: 465, width: 190, height: 485 };
const lavaBands = [
  [465, 1155, 1220], [545, 1160, 1225], [610, 1210, 1260],
  [680, 1210, 1290], [760, 1208, 1298], [850, 1195, 1295],
  [930, 1190, 1300], [950, 1190, 1300],
];

// The chain crosses the fissure. Even its warm reflected highlights are cut
// out, so they cannot inherit the lava's motion.
const chainStops = [
  [728, 1390], [763, 1368], [805, 1338], [845, 1307],
  [882, 1279], [927, 1243], [952, 1216],
];
const protectedRocks = [
  [1275, 555, 26, 30], [1220, 665, 19, 15],
  [1270, 745, 19, 20], [1220, 905, 28, 22],
];

function lavaAlpha(x, y, red, green, blue) {
  const left = interpolateBand(y, lavaBands, 1);
  const right = interpolateBand(y, lavaBands, 2);
  const insideFissure = smoothstep(left, left + 5, x)
    * (1 - smoothstep(right - 5, right, x))
    * smoothstep(465, 480, y)
    * (1 - smoothstep(935, 950, y));
  const originalHeat = smoothstep(160, 200, red)
    * smoothstep(45, 90, green)
    * smoothstep(36, 78, red - green)
    * smoothstep(8, 34, green - blue * 1.15);
  let protectedArea = 1;
  if (y >= 720 && y <= 958) {
    const chainX = interpolateBand(y, chainStops, 1);
    protectedArea *= smoothstep(16, 23, Math.abs(x - chainX));
  }
  for (const [rockX, rockY, radiusX, radiusY] of protectedRocks) {
    const distance = Math.hypot((x - rockX) / radiusX, (y - rockY) / radiusY);
    protectedArea *= smoothstep(.85, 1.2, distance);
  }
  return insideFissure * originalHeat * protectedArea;
}

function makeLavaSurface(image) {
  const { x, y, width, height } = lavaBounds;
  const texture = document.createElement('canvas');
  texture.width = width;
  texture.height = height;
  const textureCtx = texture.getContext('2d');
  textureCtx.drawImage(image, x, y, width, height, 0, 0, width, height);
  const pixels = textureCtx.getImageData(0, 0, width, height);
  const { data } = pixels;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = (row * width + column) * 4;
      data[index + 3] = Math.round(data[index + 3] * lavaAlpha(
        x + column, y + row, data[index], data[index + 1], data[index + 2]));
    }
  }
  // Both source and destination use this mask. No rock, horn, chain, or ruin
  // pixels are ever sampled into the moving layer.
  textureCtx.putImageData(pixels, 0, 0);
  const frame = document.createElement('canvas');
  frame.width = width;
  frame.height = height;
  return { ...lavaBounds, texture, frame, frameCtx: frame.getContext('2d') };
}

// These crops contain only distant cloud masses above the ruin silhouettes.
// Sampling the source image keeps the smoke's actual colour and texture.
const smokeRegions = [
  { x: 530, y: 173, width: 190, height: 104, period: 8.2, drift: 17, opacity: .92, phase: .2 },
  { x: 625, y: 194, width: 185, height: 96, period: 11.3, drift: 21, opacity: 1, phase: 1.8 },
  { x: 705, y: 159, width: 110, height: 108, period: 13.1, drift: 14, opacity: .86, phase: 3.4 },
];

function makeSmokeSurface(image, region) {
  const { x, y, width, height } = region;
  const texture = document.createElement('canvas');
  texture.width = width;
  texture.height = height;
  const textureCtx = texture.getContext('2d');
  textureCtx.drawImage(image, x, y, width, height, 0, 0, width, height);
  const pixels = textureCtx.getImageData(0, 0, width, height);
  const { data } = pixels;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = (row * width + column) * 4;
      const red = data[index];
      const green = data[index + 1];
      const nx = (column - width / 2) / (width / 2);
      const ny = (row - height / 2) / (height / 2);
      const feather = 1 - smoothstep(.55, 1, Math.hypot(nx, ny));
      const cloud = smoothstep(10, 30, red)
        * (1 - smoothstep(108, 155, red))
        * smoothstep(2, 18, red - green);
      data[index + 3] = Math.round(data[index + 3] * feather * cloud);
      data[index] = Math.round(red * .7);
      data[index + 1] = Math.round(green * .72);
      data[index + 2] = Math.round(data[index + 2] * .74);
    }
  }
  textureCtx.putImageData(pixels, 0, 0);
  const frame = document.createElement('canvas');
  frame.width = width;
  frame.height = height;
  return { ...region, texture, frame, frameCtx: frame.getContext('2d') };
}

function drawSmoke(ctx, seconds, surfaces) {
  if (!surfaces) return;
  for (const surface of surfaces) {
    const { width, height, texture, frame, frameCtx } = surface;
    const phase = seconds * TAU / surface.period + surface.phase;
    frameCtx.clearRect(0, 0, width, height);
    for (let y = 0; y < height; y += 4) {
      const stripHeight = Math.min(4, height - y);
      const shiftX = surface.drift * Math.sin(phase + y * .011)
        + 3 * Math.sin(phase * .57 + y * .026);
      const sourceY = Math.max(0, Math.min(height - stripHeight,
        y + 3 * Math.sin(phase * .72 + y * .024)));
      frameCtx.drawImage(texture, 0, sourceY, width, stripHeight,
        shiftX, y, width, stripHeight);
    }
    // The extracted cloud pixels are already feathered. Let them drift inside
    // the empty sky instead of multiplying their alpha by a second mask.
    ctx.globalAlpha = surface.opacity * (.84 + .16 * Math.sin(seconds * .31 + surface.phase));
    ctx.drawImage(frame, surface.x, surface.y);
  }
  ctx.globalAlpha = 1;
}

function drawLava(ctx, seconds, surface) {
  if (!surface) return;
  const { width, height, texture, frame, frameCtx } = surface;
  // Two slow, incommensurate speed changes prevent a visibly identical loop.
  const flow = seconds / 4.1 + .045 * Math.sin(seconds * .21)
    + .02 * Math.sin(seconds * .37);
  const cycle = flow - Math.floor(flow);
  const travel = 17;
  frameCtx.clearRect(0, 0, width, height);
  frameCtx.globalCompositeOperation = 'lighter';
  for (let y = 0; y < height; y += 4) {
    const stripHeight = Math.min(4, height - y);
    const wave = 1.1 * (Math.sin(y * .032 - cycle * TAU) - Math.sin(y * .032));
    const positions = [y - cycle * travel + wave,
      y + (1 - cycle) * travel + wave];
    const weights = [1 - cycle, cycle];
    for (let index = 0; index < positions.length; index += 1) {
      frameCtx.globalAlpha = weights[index];
      const sourceY = Math.max(0, Math.min(height - stripHeight, positions[index]));
      frameCtx.drawImage(texture, 0, sourceY, width, stripHeight,
        0, y, width, stripHeight);
    }
  }
  frameCtx.globalAlpha = 1;
  frameCtx.globalCompositeOperation = 'destination-in';
  frameCtx.drawImage(texture, 0, 0);
  frameCtx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = .95;
  ctx.filter = `brightness(${1.01 + .09 * Math.sin(seconds * 1.34
    + .7 * Math.sin(seconds * .19))})`;
  ctx.drawImage(frame, surface.x, surface.y);
  ctx.restore();
}

function drawGlow(ctx, x, y, radiusX, radiusY, colour, opacity) {
  if (opacity <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(radiusX, radiusY);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, `rgba(${colour},${opacity})`);
  gradient.addColorStop(.42, `rgba(${colour},${opacity * .35})`);
  gradient.addColorStop(1, `rgba(${colour},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, TAU);
  ctx.fill();
  ctx.restore();
}

const lightningZones = [
  { left: 558, width: 80, top: 46 },
  { left: 672, width: 83, top: 34 },
  { left: 735, width: 58, top: 25 },
];

function makeLightning(random, previousZone, seconds) {
  let zone = Math.floor(random() * lightningZones.length);
  if (zone === previousZone) zone = (zone + 1 + Math.floor(random() * 2)) % lightningZones.length;
  const target = lightningZones[zone];
  let x = target.left + random() * target.width;
  let y = target.top + random() * 27;
  const points = [{ x, y }];
  const count = 5 + Math.floor(random() * 3);
  for (let index = 0; index < count; index += 1) {
    x = Math.max(520, Math.min(885, x + (random() - .5) * 38));
    y += 18 + random() * 9;
    points.push({ x, y });
  }
  return { zone, start: seconds, points,
    branchAt: 2 + Math.floor(random() * 2),
    branchDirection: random() < .5 ? -1 : 1 };
}

function drawLightning(ctx, seconds, lightning) {
  if (!lightning) return;
  const age = seconds - lightning.start;
  if (age < 0 || age > .38) return;
  const flash = Math.max(Math.exp(-age * 16),
    .75 * Math.exp(-Math.abs(age - .16) * 13));
  const middle = lightning.points[Math.floor(lightning.points.length / 2)];
  ctx.save();
  ctx.beginPath();
  ctx.rect(522, 16, 299, 248);
  ctx.clip();
  drawGlow(ctx, middle.x, middle.y, 95, 68, '183,196,214', flash * .27);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#b9c7da';
  ctx.shadowBlur = 14;
  ctx.lineWidth = 2.3;
  ctx.strokeStyle = `rgba(230,236,244,${flash * .9})`;
  ctx.beginPath();
  lightning.points.forEach(({ x, y }, index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const branch = lightning.points[lightning.branchAt];
  ctx.lineWidth = .9;
  ctx.strokeStyle = `rgba(205,220,238,${flash * .55})`;
  ctx.beginPath();
  ctx.moveTo(branch.x, branch.y);
  ctx.lineTo(branch.x + lightning.branchDirection * 19, branch.y + 16);
  ctx.lineTo(branch.x + lightning.branchDirection * 12, branch.y + 30);
  ctx.stroke();
  ctx.restore();
}

function makeEmberSprites(image) {
  return [[1210, 795], [1215, 815], [1208, 840]].map(([sourceX, sourceY]) => {
    const sprite = document.createElement('canvas');
    sprite.width = 18;
    sprite.height = 18;
    const spriteCtx = sprite.getContext('2d');
    spriteCtx.drawImage(image, sourceX, sourceY, 18, 18, 0, 0, 18, 18);
    const pixels = spriteCtx.getImageData(0, 0, 18, 18);
    const { data } = pixels;
    for (let y = 0; y < 18; y += 1) {
      for (let x = 0; x < 18; x += 1) {
        const index = (y * 18 + x) * 4;
        const distance = Math.hypot((x - 8.5) / 8.5, (y - 8.5) / 8.5);
        const alpha = (1 - smoothstep(.48, 1, distance))
          * smoothstep(120, 175, data[index])
          * smoothstep(55, 100, data[index] - data[index + 1])
          * (1 - smoothstep(145, 190, data[index + 1]));
        data[index + 3] = Math.round(data[index + 3] * alpha);
      }
    }
    spriteCtx.putImageData(pixels, 0, 0);
    return sprite;
  });
}

const eruptionSites = [
  { x: 618, y: 307, spread: 31, count: 25 },
  { x: 647, y: 294, spread: 23, count: 30 },
  { x: 684, y: 304, spread: 36, count: 23 },
];

function makeEruption(random, previousSite, seconds) {
  let site = Math.floor(random() * eruptionSites.length);
  if (site === previousSite) site = (site + 1 + Math.floor(random() * 2)) % eruptionSites.length;
  const origin = eruptionSites[site];
  const particles = Array.from({ length: origin.count }, () => ({
    delay: random() * .35,
    velocityX: (random() - .5) * origin.spread * 2,
    velocityY: 54 + random() * 66,
    gravity: 51 + random() * 34,
    size: 7 + random() * 8,
    spriteIndex: Math.floor(random() * 3),
    lifetime: .85 + random() * .55,
  }));
  return { site, start: seconds, origin, particles };
}

function drawEruption(ctx, seconds, eruption, sprites) {
  if (!eruption || !sprites) return;
  const age = seconds - eruption.start;
  if (age < 0 || age > 1.8) return;
  ctx.save();
  // The distant ridge is the emitter. Particles remain above it, never across
  // the foreground party, ruins, Diablo, or the menu.
  ctx.beginPath();
  ctx.rect(538, 183, 288, 139);
  ctx.clip();
  const flash = Math.max(0, 1 - age / .7);
  drawGlow(ctx, eruption.origin.x, eruption.origin.y,
    45, 27, '255,104,32', flash * .3);
  for (const particle of eruption.particles) {
    const time = age - particle.delay;
    if (time <= 0 || time >= particle.lifetime) continue;
    const progress = time / particle.lifetime;
    const x = eruption.origin.x + particle.velocityX * time;
    const y = eruption.origin.y - particle.velocityY * time
      + particle.gravity * time * time;
    const size = particle.size * (1 - progress * .45);
    ctx.globalAlpha = Math.sin(progress * Math.PI) * .95;
    ctx.shadowColor = '#ef541c';
    ctx.shadowBlur = 8;
    ctx.drawImage(sprites[particle.spriteIndex], x - size / 2, y - size / 2, size, size);
  }
  ctx.restore();
}

export function createMenuAtmosphere(root) {
  const canvas = document.createElement('canvas');
  canvas.className = 'main-menu-atmosphere';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.effectLayers = 'lava smoke lightning eruption';
  canvas.dataset.lavaReady = 'false';
  canvas.dataset.atmosphereReady = 'false';
  root.prepend(canvas);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { setActive() {} };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const random = randomGenerator((Math.random() * 0x100000000) >>> 0);
  const lightningEvents = [];
  const eruptionEvents = [];
  canvas.__rotwLightningEvents = lightningEvents;
  canvas.__rotwEruptionEvents = eruptionEvents;
  let lightning = null;
  let nextLightning = 3 + random() * 3;
  let lastLightningZone = -1;
  let eruption = null;
  let nextEruption = 6 + random() * 3;
  let lastEruptionSite = -1;
  let lavaSurface = null;
  let smokeSurfaces = null;
  let emberSprites = null;
  const image = new Image();
  image.decoding = 'async';
  image.addEventListener('load', () => {
    lavaSurface = makeLavaSurface(image);
    smokeSurfaces = smokeRegions.map(region => makeSmokeSurface(image, region));
    emberSprites = makeEmberSprites(image);
    canvas.dataset.lavaReady = 'true';
    canvas.dataset.atmosphereReady = 'true';
  }, { once: true });
  image.src = '/app/assets/main-menu-user-reference-v1.png';

  let active = false;
  let animationFrame = 0;
  let lastFrame = 0;
  let elapsed = 0;
  let pixelRatio = 1;

  function resize() {
    const width = root.clientWidth || window.innerWidth;
    const height = root.clientHeight || window.innerHeight;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25,
      Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
    const pixelsWide = Math.max(1, Math.round(width * pixelRatio));
    const pixelsHigh = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
  }

  function render(seconds) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    canvas.__rotwSeconds = seconds;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(width / SCENE_WIDTH, height / SCENE_HEIGHT);
    ctx.setTransform(pixelRatio * scale, 0, 0, pixelRatio * scale,
      pixelRatio * (width - SCENE_WIDTH * scale) / 2,
      pixelRatio * (height - SCENE_HEIGHT * scale) / 2);
    if (seconds >= nextLightning) {
      lightning = makeLightning(random, lastLightningZone, seconds);
      lastLightningZone = lightning.zone;
      lightningEvents.push({ time: seconds, zone: lightning.zone,
        x: lightning.points[0].x });
      if (lightningEvents.length > 32) lightningEvents.shift();
      nextLightning = seconds + 3 + random() * 3;
    }
    if (seconds >= nextEruption) {
      if (lightning && seconds - lightning.start < .6) {
        nextEruption = seconds + 1.2;
      } else {
        eruption = makeEruption(random, lastEruptionSite, seconds);
        lastEruptionSite = eruption.site;
        eruptionEvents.push({ time: seconds, site: eruption.site,
          x: eruption.origin.x });
        if (eruptionEvents.length > 32) eruptionEvents.shift();
        nextEruption = seconds + 10 + random() * 5;
      }
    }
    drawSmoke(ctx, seconds, smokeSurfaces);
    drawLightning(ctx, seconds, lightning);
    drawEruption(ctx, seconds, eruption, emberSprites);
    drawLava(ctx, seconds, lavaSurface);
  }

  function frame(now) {
    animationFrame = 0;
    if (!active || document.hidden || reducedMotion.matches) {
      sync();
      return;
    }
    if (!lastFrame || now - lastFrame >= FRAME_MS) {
      if (lastFrame) elapsed += Math.min(now - lastFrame, 100);
      lastFrame = now;
      render(elapsed / 1000);
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function sync() {
    const shouldRun = active && !document.hidden && !reducedMotion.matches;
    if (shouldRun && !animationFrame) {
      resize();
      lastFrame = 0;
      canvas.dataset.motion = 'running';
      animationFrame = requestAnimationFrame(frame);
    } else if (!shouldRun) {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastFrame = 0;
      canvas.dataset.motion = reducedMotion.matches ? 'reduced' : 'paused';
      if (reducedMotion.matches) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  window.addEventListener('resize', () => {
    resize();
    sync();
  }, { passive: true });
  return {
    setActive(value) {
      active = Boolean(value);
      sync();
    },
  };
}
