#!/usr/bin/env node
/* v7.17 behavior tests — extracted from the SHIPPED file (never a re-typed copy).
   Covers: portBuildPlan default (v7.13 tree unchanged) vs typed override (sandbox),
   slot fill/create/skip rules, and the sandbox share-link codec round-trip. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extract a top-level `function name(...){...}` (brace-counting, string/template-naive but
// fine for these specific functions which contain no unbalanced braces in strings).
function extractFn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('function not found: ' + name);
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return src.slice(i, k + 1);
}
function extractConst(name) {
  const m = src.match(new RegExp('const ' + name + '=[^;]+;'));
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

let fails = 0, n = 0;
const eq = (a, b, label) => { n++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fails++; console.log('  ✗ ' + label + '\n      got      ' + JSON.stringify(a) + '\n      expected ' + JSON.stringify(b)); } else console.log('  ✓ ' + label); };
const truthy = (v, label) => { n++; if (!v) { fails++; console.log('  ✗ ' + label); } else console.log('  ✓ ' + label); };

/* ── portDecideType + portBuildPlan ── */
const sandboxEval = new Function(
  extractFn('portDecideType') + '\n' + extractFn('portBuildPlan') + '\n' +
  'return {portDecideType, portBuildPlan};'
);
const { portDecideType, portBuildPlan } = sandboxEval();

console.log('[1] v7.13 role-based tree UNCHANGED');
eq(portDecideType(['VERSE']), 'VERSE', 'verse → VERSE');
eq(portDecideType(['TOP','BOTTOM']), 'VERSE', 'top+bottom → VERSE');
eq(portDecideType(['TOP']), 'TOP', 'top → TOP');
eq(portDecideType(['BOTTOM']), 'BOTTOM', 'bottom → BOTTOM');
eq(portDecideType([]), 'ALTERNATE', 'no data → ALTERNATE');

console.log('[2] portBuildPlan default (no typeOf) behaves exactly as before');
const slots = [
  { id: 's1', name: 'TOP1',    linked: ['111'] },
  { id: 's2', name: 'TOP2',    linked: [] },
  { id: 's3', name: 'BOTTOM1', linked: [] },
  { id: 's4', name: 'VERSE1',  linked: [] },
  { id: 's5', name: 'notes',   linked: ['999'] },   // non-slot subitem still blocks its models
];
const models = [
  { id: '111', name: 'Already', roleLabels: ['TOP'] },
  { id: '222', name: 'TopGuy',  roleLabels: ['TOP'] },
  { id: '333', name: 'TopGuy2', roleLabels: ['TOP'] },
  { id: '444', name: 'NoData',  roleLabels: [] },
];
const p1 = portBuildPlan(models, slots);
eq(p1.skipped.map(s => s.model.id), ['111'], 'linked-anywhere model skipped');
eq(p1.actions.map(a => [a.model.id, a.type, a.mode, a.slotName]),
  [['222','TOP','fill','TOP2'], ['333','TOP','create','TOP3'], ['444','ALTERNATE','create','ALTERNATE1']],
  'fill lowest empty, then create max+1, no-data → ALTERNATE');

console.log('[3] typed override (sandbox): column placement wins over profile');
const typeById = { '222': 'BOTTOM', '333': 'VERSE', '444': 'TOP' };   // deliberately contradicts roles
const p2 = portBuildPlan(models, slots, m => typeById[String(m.id)]);
eq(p2.actions.map(a => [a.model.id, a.type, a.mode, a.slotName]),
  [['222','BOTTOM','fill','BOTTOM1'], ['333','VERSE','fill','VERSE1'], ['444','TOP','fill','TOP2']],
  'forced types route to those columns\' slots (a life-verse can be THIS-shoot bottom)');
truthy(p2.skipped.length === 1 && p2.skipped[0].model.id === '111', 'already-linked still skipped under override');

console.log('[5] v7.20 order-based sandbox plan (sbBuildPlan)');
const sbEval = new Function('kanbanItems',
  extractFn('sbBuildPlan') + '\nreturn {sbBuildPlan};');
// occupant "Bob" (id 900) sits in TOP1 already; TOP2 exists empty; TOP3 does not exist.
const kb = [{ id: '900', name: 'Bob' }];
const sbSlots = [
  { id: 'st1', name: 'TOP1', linked: ['900'] },
  { id: 'st2', name: 'TOP2', linked: [] },
  { id: 'sb1', name: 'BOTTOM1', linked: ['700'] },   // Alice(700) already here
];
const { sbBuildPlan } = sbEval(kb);
// entries: Alice(700) placed at TOP position 1 (was BOTTOM1); Carol(701) at TOP position 2; Dan(702) TOP3; Alice also as-is at BOTTOM1 to test skip
const sbEntries = [
  { model: { id: '700', name: 'Alice' }, type: 'TOP', num: 1 },   // TOP1 occupied by Bob → relink, replaces Bob
  { model: { id: '701', name: 'Carol' }, type: 'TOP', num: 2 },   // TOP2 empty → fill
  { model: { id: '702', name: 'Dan' },   type: 'TOP', num: 3 },   // TOP3 missing → create
  { model: { id: '700', name: 'Alice' }, type: 'BOTTOM', num: 1 },// BOTTOM1 already Alice → skip
];
const sp = sbBuildPlan(sbEntries, sbSlots);
eq(sp.actions.map(a => [a.model.name, a.slotName, a.mode, a.replaces || null]),
  [['Alice','TOP1','fill','Bob'], ['Carol','TOP2','fill',null], ['Dan','TOP3','create',null]],
  'position→TYPE{num}: relink (replaces Bob), fill empty, create missing');
eq(sp.skipped.map(s => [s.model.name, s.reason]), [['Alice','already in BOTTOM1']],
  'person already sitting in their exact target slot is skipped');

console.log('[4] share-link codec round-trip');
const codecEval = new Function('btoa', 'atob',
  'let sbState={tag:"18", zones:{b:["1"],v:["2","3"],t:[],ab:[],av:["4"],at:[]}};\n' +
  extractFn('sbEncode') + '\n' + extractFn('sbDecode') + '\n' +
  'return {enc: sbEncode(), dec: (s)=>sbDecode(s)};'
);
const b64 = { btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary') };
const { enc, dec } = codecEval(b64.btoa, b64.atob);
truthy(/^[A-Za-z0-9_-]+$/.test(enc), 'encoded link is URL-safe (no + / = chars)');
eq(dec(enc), { t: '18', zones: undefined, z: { b:['1'], v:['2','3'], t:[], ab:[], av:['4'], at:[] } }.z ? { t:'18', z:{ b:['1'], v:['2','3'], t:[], ab:[], av:['4'], at:[] } } : null, 'round-trip preserves tag + zones exactly');
eq(dec('%%%garbage%%%'), null, 'garbage decodes to null, not a crash');

console.log('[6] v7.29 sandbox notes: pay/dates flow through sbBuildPlan');
// entries carry pay/dates (attached upstream in sbPortOpen). Verify sbBuildPlan copies
// them onto BOTH fill and create actions, and leaves them empty-string when absent.
const sbNotesEntries = [
  { model: { id: '701', name: 'Carol' }, type: 'TOP', num: 2, pay: '$1200 flat', dates: 'Aug 4-6' }, // fill TOP2
  { model: { id: '702', name: 'Dan' },   type: 'TOP', num: 3, pay: '', dates: '' },                   // create TOP3, no note
];
const spN = sbBuildPlan(sbNotesEntries, sbSlots);
eq(spN.actions.map(a => [a.model.name, a.mode, a.pay, a.dates]),
  [['Carol','fill','$1200 flat','Aug 4-6'], ['Dan','create','','']],
  'pay/dates copied onto fill + create actions (empty when absent)');

console.log('[7] v7.29 notes codec round-trip (sbNormalizeNotes)');
const notesEval = new Function(extractFn('sbNormalizeNotes') + '\nreturn {sbNormalizeNotes};');
const { sbNormalizeNotes } = notesEval();
eq(sbNormalizeNotes({ '700': { pay: '$500', dates: 'Sep 1' } }), { '700': { pay: '$500', dates: 'Sep 1' } },
  'well-formed notes preserved');
eq(sbNormalizeNotes({ '700': { pay: '', dates: '' }, '701': { pay: 'x', dates: '' } }), { '701': { pay: 'x', dates: '' } },
  'entries with both fields blank are dropped');
eq(sbNormalizeNotes(null), {}, 'null → empty object, not a crash');
eq(sbNormalizeNotes({ '700': { pay: 42, dates: null } }), { '700': { pay: '42', dates: '' } },
  'coerces non-string values to trimmed strings');

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails ? 1 : 0);
