import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

function audit() {
  const html = read('app/index.html');
  const main = read('app/main.js');
  const css = read('app/styles.css');
  const authoredTags = [...`${html}\n${main}`.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  const missingType = authoredTags.filter(([, attributes]) => !/\btype\s*=\s*["']button["']/i.test(attributes)).length;
  const missingName = authoredTags.filter(([, attributes, body]) => {
    const text = body.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim();
    return !text && !/\baria-label\s*=|\btitle\s*=/i.test(attributes);
  }).length;
  const selectorTokens = [...new Set(css.match(/(?:\.|#)[A-Za-z][A-Za-z0-9_-]*/g) ?? [])];
  const sourceWithoutCss = `${html}\n${main}`;
  const uncertainDeadCandidates = selectorTokens.filter((token) => !sourceWithoutCss.includes(token));
  const report = {
    buttons: authoredTags.length,
    missingType,
    missingAccessibleName: missingName,
    cssSelectorTokens: selectorTokens.length,
    cssUncertainCandidates: uncertainDeadCandidates.length,
    jsDebuggerCount: (main.match(/\bdebugger\b/g) ?? []).length,
    jsMergeMarkerCount: (main.match(/^<<<<<<<|^=======|^>>>>>>>/gm) ?? []).length,
    policy: 'Candidates are reported only; no CSS/JS deletion is automatic because dynamic class/helper use may be indirect.',
  };
  if (missingType || missingName || report.jsDebuggerCount || report.jsMergeMarkerCount) {
    throw new Error(`UI quality contract failed: ${JSON.stringify(report)}`);
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) audit();
export { audit };
