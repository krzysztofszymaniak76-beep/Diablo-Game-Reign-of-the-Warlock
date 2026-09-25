import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8');

test('all authored HTML buttons declare a non-submit type', () => {
  for (const relative of ['app/index.html', 'app/main.js']) {
    const source = read(relative);
    const missing = [...source.matchAll(/<button\b[^>]*>/gi)]
      .map((match) => match[0])
      .filter((tag) => !/\btype\s*=\s*["']button["']/i.test(tag));
    assert.deepEqual(missing, [], `${relative} has button(s) without type: ${missing.join(' | ')}`);
  }
});

test('runtime source contains no debugger statements or accidental merge markers', () => {
  for (const relative of ['app/main.js', 'src/core/skill-execution.js', 'src/core/mouse-skills.js', 'src/core/hero-control-save.js']) {
    const source = read(relative);
    assert.equal(/\bdebugger\b/.test(source), false, `${relative} contains debugger`);
    assert.equal(/^<<<<<<<|^=======|^>>>>>>>/m.test(source), false, `${relative} contains merge markers`);
  }
});

test('intentional deferred corpse lifecycle remains documented instead of silently shipping', () => {
  const source = read('src/core/skill-execution.js');
  assert.match(source, /TODO: integrate saved battlefield death\/corpse lifecycle/);
  assert.match(read('MAINTENANCE_BACKLOG_v0.5.6.md'), /corpse-based|cykl corpse/i);
});
