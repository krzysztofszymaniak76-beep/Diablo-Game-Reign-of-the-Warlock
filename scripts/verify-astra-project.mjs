import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const checks=[];
const run=(label,args)=>{
  const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024});
  checks.push({label,status:r.status,summary:(r.stdout+'\n'+r.stderr).trim().split('\n').slice(-10).join('\n')});
  if(r.status!==0)throw new Error(`${label}\n${r.stdout}\n${r.stderr}`);
};
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const manifests=fs.readdirSync(root).filter(f=>/^RELEASE_MANIFEST_v0\.5\.6\.json$/.test(f));
if(process.argv.includes('--manifest')){
  if(manifests.length!==1)throw new Error('Missing extracted release manifest');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,manifests[0])));
  for(const f of manifest.files){
    const absolute=path.resolve(root,f.path);if(!absolute.startsWith(root+path.sep))throw new Error('Unsafe manifest path');
    const bytes=fs.readFileSync(absolute);if(bytes.length!==f.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw new Error(`Manifest mismatch ${f.path}`);
  }
  checks.push({label:'extracted manifest hashes',status:0,files:manifest.files.length});
}
const syntaxFiles=['app','src','scripts','test','data'].flatMap(d=>walk(path.join(root,d))).filter(p=>/\.(m?js)$/.test(p));
for(const file of syntaxFiles)run(`syntax ${path.relative(root,file)}`,['--check',file]);
const runs=process.argv.includes('--three')?3:1;
for(let i=1;i<=runs;i++)run(`core ${i}`,['--test',...fs.readdirSync(path.join(root,'test')).filter(p=>p.endsWith('.test.js')).sort().map(p=>path.join('test',p))]);
for(const [script,args] of [['build-equipment-data.mjs',['--check']],['build-skill-mouse-bindings.mjs',['--check']],['trace-necroskeleton.mjs',['--check']],['audit-reference-import.mjs',[]],['audit-skill-data.mjs',[]],['fourth-pass-audit.mjs',[]]])run(script,[`scripts/${script}`,...args]);
const output={project:root,status:'PASS',syntaxFiles:syntaxFiles.length,coreRuns:runs,checks};
fs.mkdirSync(path.join(root,'outputs'),{recursive:true});fs.writeFileSync(path.join(root,'outputs/astra-verification.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({status:output.status,syntaxFiles:output.syntaxFiles,core:checks.filter(c=>c.label.startsWith('core')),audits:6,manifest:process.argv.includes('--manifest')}));
