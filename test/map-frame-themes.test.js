import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../app/map-frame-themes.css',import.meta.url),'utf8');
test('frame theme system separates materials from a shared 9-slice structure',()=>{
 for(const token of ['--frame-image','--frame-material','--frame-wash','--frame-edge','--frame-relief-filter'])assert.ok(css.includes(token));
 assert.ok(css.includes('act1-exterior'));assert.ok(css.includes('act1-cave'));
 assert.ok(css.includes('data-map-theme="act1-cave"'));assert.ok(css.includes('data-profile="cave"'));
 assert.ok(css.includes('border-image-source:var(--frame-image)'));
});
test('frame sculptures are separate proportional non-interactive decorations',()=>{
 assert.ok(css.includes('map-sentinel-v0513.png'));assert.ok(css.includes('map-crest-v0513.png'));
 assert.ok(css.includes('center/contain no-repeat'));assert.ok(css.includes('pointer-events:none'));
 assert.ok(css.includes(':hover'));assert.ok(css.includes(':active'));assert.ok(css.includes(':focus-visible'));
 assert.doesNotMatch(css,/landscape-art|land-hit|exploration-world|data-sector-id|battlefield|canvas/);
});
