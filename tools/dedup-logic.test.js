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
  grabFn('isEmptyVal'),
  src.match(/const hasVal = [^\n]+/)[0],
  'return { hasStageNameFlag, dupNameKey, defaultKeeperId, isEmptyVal, hasVal };'
].join('\n');
const { hasStageNameFlag, dupNameKey, defaultKeeperId, isEmptyVal, hasVal } = new Function(harness)();

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

/* v7.73.1 — isEmptyVal / hasVal against the REAL monday value shapes.
   The bug this covers was seen on a live merge: monday keeps metadata after a field is cleared, so
   a long_text that once held content returns {"text":"","changed_at":"…"}. The old check only knew
   about a bare {}, so it counted as "has a value" while rendering blank, and the merge planner wrote
   `[DUPLICATE INFO — Other Studios Notes:  (from id …)]` into the keeper's General Notes.
   The 0-valued cases below matter just as much: index:0 and the number 0 are REAL values. */
console.log('[4] isEmptyVal — cleared-field metadata vs real values');
// EMPTY
eq(isEmptyVal(null), true, 'null is empty');
eq(isEmptyVal(''), true, 'empty string is empty');
eq(isEmptyVal('{}'), true, 'bare {} is empty');
eq(isEmptyVal('{"ids":[]}'), true, 'dropdown with no ids is empty');
eq(isEmptyVal('{"labels":[]}'), true, 'dropdown with no labels is empty');
eq(isEmptyVal('{"text":"","changed_at":"2026-07-29T21:18:12.000Z"}'), true,
   'CLEARED long_text (text:"" + changed_at) is empty — the actual bug');
eq(isEmptyVal('{"changed_at":"2026-07-29T21:18:12.000Z"}'), true, 'metadata-only value is empty');
eq(isEmptyVal('{"date":null}'), true, 'cleared date is empty');
eq(isEmptyVal('{"url":"","text":""}'), true, 'cleared link is empty');
eq(isEmptyVal('{"files":[]}'), true, 'no files is empty');
eq(isEmptyVal('{"text":"   ","changed_at":"x"}'), true, 'whitespace-only text is empty');
// NOT EMPTY — these must survive
eq(isEmptyVal('{"text":"TEST3","changed_at":"x"}'), false, 'real long_text content is NOT empty');
eq(isEmptyVal('{"index":0}'), false, 'status index 0 is a REAL value, not empty');
eq(isEmptyVal('{"index":2,"changed_at":"x"}'), false, 'status index 2 is not empty');
eq(isEmptyVal('0'), false, 'the number 0 is a REAL value, not empty');
eq(isEmptyVal('{"ids":[4,14]}'), false, 'dropdown with ids is not empty');
eq(isEmptyVal('{"date":"2026-07-29"}'), false, 'a real date is not empty');
// hasVal combines text and value
eq(hasVal({text:'', value:'{"text":"","changed_at":"x"}'}), false,
   'hasVal false for a cleared field — no blank conflict line can be logged');
eq(hasVal({text:'TESTTEST', value:'{"text":"TESTTEST"}'}), true, 'hasVal true for real content');
eq(hasVal({text:'', value:'{"index":0}'}), true, 'hasVal true when text is blank but the value is status 0');

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails?1:0);
