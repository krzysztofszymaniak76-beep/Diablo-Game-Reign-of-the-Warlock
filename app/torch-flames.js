/* A twelve-frame, alpha-transparent fire atlas; no transformation of the ironwork. */
const ATLAS_URL = '/app/assets/battle-torch-flame-atlas-v0521.png';
const COLUMNS = 4;
const ROWS = 3;
const FRAME_COUNT = COLUMNS * ROWS;
const LOOP_MS = 5200;
const CANVAS_WIDTH = 128;
const CANVAS_HEIGHT = 256;

const holders = [...document.querySelectorAll('.battlefield-shell > .battle-torch .torch-flame')];
if (holders.length === 2) {
  const atlas = new Image();
  atlas.decoding = 'async';
  atlas.src = ATLAS_URL;
  atlas.decode().then(() => {
    const frameWidth = atlas.naturalWidth / COLUMNS;
    const frameHeight = atlas.naturalHeight / ROWS;
    if (!Number.isInteger(frameWidth) || !Number.isInteger(frameHeight)) return;

    const flames = holders.map((holder) => {
      const canvas = document.createElement('canvas');
      canvas.className = 'torch-fire-canvas';
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      canvas.setAttribute('aria-hidden', 'true');
      holder.append(canvas);
      return { holder, context: canvas.getContext('2d', { alpha: true }) };
    });
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const startedAt = performance.now();

    function drawFrame(context, index, alpha) {
      context.globalAlpha = alpha;
      context.drawImage(atlas,
        (index % COLUMNS) * frameWidth,
        Math.floor(index / COLUMNS) * frameHeight,
        frameWidth, frameHeight,
        0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    function paint(now) {
      if (document.visibilityState === 'visible') {
        flames.forEach(({ holder, context }, side) => {
          const elapsed = reducedMotion.matches ? 0 : (now - startedAt + side * 1800) % LOOP_MS;
          const position = elapsed / LOOP_MS * FRAME_COUNT;
          const index = Math.floor(position) % FRAME_COUNT;
          const fraction = position - Math.floor(position);
          // Crossfade only near the end of each frame. The flame's base never moves.
          const fade = Math.max(0, Math.min(1, (fraction - .3) / .7));
          const blend = fade * fade * (3 - 2 * fade);
          context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          drawFrame(context, index, 1);
          if (blend > 0 && !reducedMotion.matches) drawFrame(context, (index + 1) % FRAME_COUNT, blend);
          context.globalAlpha = 1;
          holder.dataset.flameFrame = String(index);
        });
      }
      requestAnimationFrame(paint);
    }

    requestAnimationFrame(paint);
  }).catch(() => {
    // A missing decorative asset must not interfere with battle interaction.
  });
}
