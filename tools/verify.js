#!/usr/bin/env node
/* Pre-package verifier for public/index.html.
   Added in v7.16 after the v7.15 incident: `node --check` validates JS syntax but NOT the
   GraphQL strings inside gql(`...`) template literals — a missing brace in a query shipped
   and 403'd at the server's parse(). This script closes that gap.

   Checks:
   1. Every <script> block passes `node --check` (JS syntax).
   2. Every gql(`...`) template literal has balanced {} [] () AND parses with the real
      graphql parser (same parse() the server uses), after ${...} interpolations are
      replaced with dummy values.
   3. v7.16 structural asserts (grid scopes, routing, shoot-tag gating, toolbar rows).

   Exit 0 = all green. Exit 1 = failures printed.
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse } = require('graphql');

const FILE = process.argv[2] || path.join(__dirname, '..', 'public', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');
let fails = 0, checks = 0;
function ok(label){ checks++; console.log('  ✓ ' + label); }
function bad(label, extra){ checks++; fails++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }

/* ── 1. JS syntax of every inline <script> ─────────────────────────────── */
console.log('[1] JS syntax (node --check per <script> block)');
const scripts = [];
const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = scriptRe.exec(src))) scripts.push(m[1]);
if (!scripts.length) bad('no inline <script> blocks found');
scripts.forEach((code, i) => {
  const tmp = path.join(require('os').tmpdir(), `verify-script-${i}.js`);
  fs.writeFileSync(tmp, code);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); ok(`script block #${i + 1} (${code.length} chars)`); }
  catch (e) { bad(`script block #${i + 1} syntax error`, String(e.stderr || e.message).split('\n')[0]); }
  fs.unlinkSync(tmp);
});

/* ── 2. gql template literal guard ─────────────────────────────────────── */
console.log('[2] gql(`...`) literals: bracket balance + graphql parse()');
// Extract gql(`...`) literals with a scanner (regex would break on nested backticks in ${}).
function extractGqlLiterals(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf('gql(`', i)) !== -1) {
    let j = i + 5, depth = 0, buf = '';
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { buf += c + (text[j + 1] || ''); j += 2; continue; }
      if (c === '`' && depth === 0) break;
      if (c === '$' && text[j + 1] === '{') { depth++; buf += '${'; j += 2; continue; }
      if (depth > 0) { if (c === '{') depth++; else if (c === '}') depth--; buf += c; j++; continue; }
      buf += c; j++;
    }
    out.push({ literal: buf, at: i });
    i = j;
  }
  return out;
}
// Replace ${...} (nesting-aware) with a dummy so the string becomes plain GraphQL-ish text.
// Context-aware: an interpolation that IS the entire argument list — "(${x})" — becomes limit:1;
// value-position interpolations become 1 (valid IntValue).
function stripInterp(s) {
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let d = 1; i += 2;
      while (i < s.length && d > 0) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; }
      const prev = out.replace(/\s+$/, '').slice(-1);
      let k = i; while (k < s.length && /\s/.test(s[k])) k++;
      out += (prev === '(' && s[k] === ')') ? 'limit:1' : '1';
    } else out += s[i++];
  }
  return out;
}
function balance(s) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const closers = { '}': '{', ']': '[', ')': '(' };
  const stack = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' ) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (pairs[c]) stack.push(c);
    else if (closers[c]) { if (stack.pop() !== closers[c]) return 'mismatched ' + c + ' at pos ' + i; }
  }
  if (inStr) return 'unterminated string';
  return stack.length ? ('unclosed ' + stack.join('')) : null;
}
const lits = extractGqlLiterals(src);
if (!lits.length) bad('no gql(`...`) literals found — extractor broken?');
else console.log(`  found ${lits.length} gql literals`);
lits.forEach((L, n) => {
  const line = src.slice(0, L.at).split('\n').length;
  const balErr = balance(stripInterp(L.literal));
  if (balErr) { bad(`gql #${n + 1} (line ${line}) balance`, balErr + '  →  ' + L.literal.slice(0, 90)); return; }
  const q = stripInterp(L.literal);
  try { parse(q); ok(`gql #${n + 1} (line ${line}) balanced + parses`); }
  catch (e) { bad(`gql #${n + 1} (line ${line}) graphql parse`, String(e.message).split('\n')[0] + '  →  ' + q.slice(0, 90)); }
});

/* ── 3. v7.16 structural asserts ───────────────────────────────────────── */
console.log('[3] v7.16 structural asserts');
const has = (needle, label) => src.includes(needle) ? ok(label) : bad(label, 'missing: ' + needle);
const lacks = (needle, label) => !src.includes(needle) ? ok(label) : bad(label, 'still present: ' + needle);
has(`'2':{title:'2-POTENTIAL', ids:[10], full:true}`, 'GRID_SCOPES has 2-POTENTIAL → status idx 10, full editor');
has(`'4':{title:'4-REVIEW', ids:[9], full:true}`, 'GRID_SCOPES has 4-REVIEW → status idx 9, full editor');
has(`'5a':{title:'5-APPROVED', ids:[2,4,105], full:true}`, 'GRID_SCOPES 5a unchanged (2,4,105) + full flag');
has(`GRID_SCOPES[gridScope] && GRID_SCOPES[gridScope].full) ? 'openApprovedEditor'`, 'tile routing driven by scope.full');
has(`if(mode==='5a'||mode==='2'||mode==='4'){`, 'setMode routes 2/4/5a to the grid');
has(`setGridScope(mode);`, 'setMode passes the mode as grid scope');
has(`blk.style.display=(currentMode==='5a')?'':'none'`, 'shoot-tags editor block stays 5-APPROVED-only');
has(`const on=(gridScope==='5a');`, 'Port row stays 5-APPROVED-only');
has(`scope:'5a'`, 'Shoot Tags FILTER stays 5-APPROVED-only');
has(`'2':{filters:{},search:'',sort:'name-asc'}`, 'amState has per-tab memory for 2');
has(`'4':{filters:{},search:'',sort:'name-asc'}`, 'amState has per-tab memory for 4');
has(`class="tb-label">Sort<`, 'SORT label present in toolbar');
has(`class="tb-label">Port shoot tag to Monday<`, 'Port label restyled to match SORT');
has(`class="am-toolbar-row" id="port-wrap"`, 'Port controls are their own toolbar row');
has(`w.style.display=on?'flex':'none'`, 'portToggleUI shows the row as flex');
lacks(`class="port-label"`, 'old loud port-label markup removed');
has(`StatusValue{index}}}}}}\``, 'casting query has the fixed brace count (6 closers)');
has(`loadCandidatesForMode(currentMode==='2'||currentMode==='4'?currentMode:'5a')`, 'approved editor combo loads per-mode');
has('v7.16:', 'v7.16 deploy marker present');
/* v7.17 asserts */
has('v7.17:', 'v7.17 deploy marker present');
has(`if(mode==='sb'){`, 'setMode routes CASTING SANDBOX');
has(`hide('sb-view');`, 'setMode common section hides sb-view');
has(`else if(activeGrid==='sb') renderSandbox();`, 'refreshActiveView refreshes sandbox');
has(`data-mode="sb"`, 'CASTING SANDBOX tab button present');
has(`function portBuildPlan(models, slots, typeOf)`, 'portBuildPlan accepts typeOf override');
has(`const type=typeOf ? typeOf(m) : portDecideType(m.roleLabels);`, 'typed override falls back to role-based decision');
has(`async function portShowPlan(models, typeOf, subtitle)`, 'shared portShowPlan exists');
has(`await portShowPlan(models, null,`, 'portOpen routes through portShowPlan (role-based)');
has(`m=>typeById[String(m.id)]`, 'sandbox port forces column-based types');
has(`.port-name-input`, 'port preview names are editable inputs'); 
has(`if(a.mode==='fill' && a.origName!==a.slotName) cvObj.name=a.slotName;`, 'fill-mode rename on edited names');
has(`function kbOpenRecrop()`, 'kanban-modal recrop entry exists');
has(`✂ Recrop</button>`, 'kanban-modal has the ✂ Recrop button');
has(`async function openRecrop(itemIdArg, headIdArg)`, 'openRecrop generalized for modal callers');
has(`function refreshHeadEverywhere(itemId, hsOpt)`, 'refreshHeadEverywhere accepts explicit headshot');
has(`const SB_TYPE={b:'BOTTOM',v:'VERSE',t:'TOP',ab:'ALTERNATE',av:'ALTERNATE',at:'ALTERNATE'};`, 'sandbox column→TYPE map (VERSE naming kept)');
has(`location.hash||'').startsWith('#sb=')`, 'share-link boot hook present');
has(`sbRenderRowList(); return;`, 'portLoadRows refreshes the sandbox picker too');
/* v7.18 asserts */
has('v7.18:', 'v7.18 deploy marker present');
has('async function fetchAssetUrls(assetIds, opts)', 'fetchAssetUrls takes optional opts');
has('if(opts.onProgress){ try{ opts.onProgress(done, need.length); }catch(e){} }', 'fetchAssetUrls reports progress per chunk');
has('{chunkSize:12, onProgress:(done,total)=>{ sbFillThumbs(byId); sbProgress(done,total); }}', 'sandbox streams thumbs with progress');
has('function sbFillThumbs(byId)', 'sbFillThumbs exists (fill-by-id, no re-render)');
has('function sbProgress(done,total)', 'sbProgress exists');
has('id="sbthumb-${id}"', 'sandbox thumbs have stable ids');
has('id="sb-progress"', 'progress-bar element present');
lacks('await fetchAssetUrls(missing); renderSandbox();', 'old full-re-render-after-fetch path removed');
has('<textarea class="dup-edit dup-edit-multi" rows="2"', 'dup editable rows are multi-line textareas');
has('.dup-preview-actions .merge-btn{padding:12px 26px', 'dup Confirm button enlarged');
has('.dup-edit-multi{', 'multi-line row CSS present');
// Guard against duplicate element ids from the toolbar rebuild:
['am-title','am-search','am-sort','am-count','am-filterbtns','port-wrap','port-tag','port-btn','port-row-btn','port-row-picker','port-row-search','port-row-list',
 'sb-view','sb-tag','sb-count','sb-board','sb-empty','sb-row-btn','sb-row-picker','sb-row-search','sb-row-list','sb-progress'].forEach(id=>{
  const c = (src.match(new RegExp('id="' + id + '"', 'g')) || []).length;
  c === 1 ? ok(`id "${id}" unique`) : bad(`id "${id}" appears ${c} times`);
});

console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
