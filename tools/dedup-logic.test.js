#!/usr/bin/env node
/* v7.24 dedup logic test — extracts the real helpers from index.html and proves that a plain name groups
   with its "(NEEDS STAGE NAME)" twin, bare placeholders don't collapse, and the keeper defaults to the
   flagged row. statusRank is stubbed (the flag preference is what we're testing). */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function grabFn(name){
  const i = src.indexOf('function '+name+'('); if(i<0) throw new Error('fn not found: '+name);
  let j=src.indexOf('{',i), d=0,k=j; for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
  return src.slice(i,k+1);
}
const reLine = src.match(/const STAGE_FLAG_RE =[^\n]+/)[0];
const harness = [
  reLine,
  grabFn('hasStageNameFlag'),
  grabFn('dupNameKey'),
  'function statusRank(){ return 0; }',   // stub — flag preference is the unit under test
  grabFn('defaultKeeperId'),
  'return { hasStageNameFlag, dupNameKey, defaultKeeperId };'
].join('\n');
const { hasStageNameFlag, dupNameKey, defaultKeeperId } = new Function(harness)();

let n=0, fails=0;
const eq=(a,b,l)=>{ n++; if(JSON.stringify(a)===JSON.stringify(b)) console.log('  ✓ '+l); else { fails++; console.log('  ✗ '+l+'  got '+JSON.stringify(a)+' want '+JSON.stringify(b)); } };

console.log('[1] hasStageNameFlag');
eq(hasStageNameFlag('John Smith (NEEDS STAGE NAME)'), true,  'flagged suffix → true');
eq(hasStageNameFlag('Jane Doe (needs info)'),         true,  'needs info suffix → true');
eq(hasStageNameFlag('John Smith'),                    false, 'plain name → false');
eq(hasStageNameFlag('(NEEDS STAGE NAME)'),            false, 'bare placeholder → false');
eq(hasStageNameFlag('(no name found)'),               false, 'no-name placeholder → false');

console.log('[2] dupNameKey groups the twin, keeps placeholders distinct');
eq(dupNameKey('John Smith (NEEDS STAGE NAME)') === dupNameKey('John Smith'), true, 'twin shares plain key');
eq(dupNameKey('John Smith'), 'john smith', 'plain key lowercased');
eq(dupNameKey('  John Smith  (Needs Stage Name) '), 'john smith', 'trims + strips flexibly');
eq(dupNameKey('(needs stage name)'), '(needs stage name)', 'bare placeholder NOT collapsed to empty');
eq(dupNameKey('(no name found)') === dupNameKey('(needs stage name)'), false, 'distinct placeholders stay distinct');

console.log('[3] defaultKeeperId prefers the flagged row');
const older='2024-01-01T00:00:00Z', newer='2024-06-01T00:00:00Z';
eq(defaultKeeperId({items:[
  {id:'A', name:'John Smith', created_at:older, statusIdx:2},
  {id:'B', name:'John Smith (NEEDS STAGE NAME)', created_at:newer, statusIdx:11},
]}), 'B', 'keeps flagged twin even though it is newer');
eq(defaultKeeperId({items:[
  {id:'A', name:'John Smith', created_at:older, statusIdx:2},
  {id:'C', name:'John Smith', created_at:newer, statusIdx:2},
]}), 'A', 'no flag → falls back to oldest (statusRank stubbed equal)');

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails?1:0);
