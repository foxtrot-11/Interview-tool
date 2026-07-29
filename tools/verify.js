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

/* ── 2b. CSS STRUCTURAL INTEGRITY (added v7.70.1) ──────────────────────────
   WHY THIS EXISTS: v7.70 shipped a broken stylesheet to production. An edit left prose sitting
   between a comment's closing star-slash and the next rule, so the CSS parser treated that prose
   as a selector and swallowed the rules after it — the entire app rendered unstyled, with hidden
   modals visible and views stacked on top of each other.
   Nothing caught it. The <script> parse check only looks at JS. Every substring assert below still
   passed, because the text WAS present — just not inside a comment. This block closes that gap:
   an orphaned or unterminated comment, or unbalanced braces, now fails the suite. */
console.log('[2b] CSS structural integrity');
{
  const sIdx = src.indexOf('<style>'), eIdx = src.indexOf('</style>');
  if (sIdx < 0 || eIdx < 0) bad('CSS block located', 'no <style> block found');
  else {
    ok('CSS block located');
    const css = src.slice(sIdx + 7, eIdx);
    const cssLineOf = off => src.slice(0, sIdx + 7 + off).split('\n').length;
    let i = 0, open = 0, orphans = [], firstOpen = -1;
    while (i < css.length) {
      if (css.startsWith('/*', i)) { if (open === 0) firstOpen = i; open++; i += 2; continue; }
      if (css.startsWith('*/', i)) { if (open === 0) orphans.push(cssLineOf(i)); else open--; i += 2; continue; }
      i++;
    }
    orphans.length
      ? bad('no orphaned CSS comment terminators', `stray */ at file line(s) ${orphans.join(', ')} — prose is leaking into the stylesheet`)
      : ok('no orphaned CSS comment terminators');
    open
      ? bad('all CSS comments terminated', `${open} unterminated /* (first at file line ${cssLineOf(firstOpen)})`)
      : ok('all CSS comments terminated');

    // Brace balance, ignoring comment bodies and quoted strings.
    let depth = 0, minDepth = 0, inC = false, q = null;
    for (let j = 0; j < css.length; j++) {
      const c = css[j];
      if (inC) { if (css.startsWith('*/', j)) { inC = false; j++; } continue; }
      if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
      if (css.startsWith('/*', j)) { inC = true; j++; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth < minDepth) minDepth = depth; }
    }
    depth === 0 ? ok('CSS braces balanced') : bad('CSS braces balanced', `net depth ${depth}`);
    minDepth === 0 ? ok('CSS never closes more braces than it opens') : bad('CSS never closes more braces than it opens', `went to ${minDepth}`);

    // Blank out comment BODIES (keeping newlines) so line numbers still line up, then look for
    // English prose left behind in live CSS. A bare sentence outside a comment is the exact
    // signature of the v7.70 break, and it is what the parser mistakes for a selector.
    let stripped = '', k = 0, inCmt = false;
    while (k < css.length) {
      if (!inCmt && css.startsWith('/*', k)) { inCmt = true; stripped += '  '; k += 2; continue; }
      if (inCmt && css.startsWith('*/', k)) { inCmt = false; stripped += '  '; k += 2; continue; }
      stripped += inCmt ? (css[k] === '\n' ? '\n' : ' ') : css[k];
      k++;
    }
    const baseLine = src.slice(0, sIdx + 7).split('\n').length;
    const prose = [];
    stripped.split('\n').forEach((ln, n) => {
      const t = ln.trim();
      if (!t) return;
      if (/[{}:;@]/.test(t)) return;              // any real CSS punctuation → not bare prose
      if (/^[),.'"\d>+~*-]/.test(t)) return;       // continuation of a selector or value list
      // 20+ chars of words and spaces with no CSS syntax anywhere = a sentence in the stylesheet
      if (/^[A-Za-z][A-Za-z ,'’()—-]{20,}$/.test(t)) prose.push(baseLine + n);
    });
    prose.length
      ? bad('no bare prose lines in the stylesheet', `file line(s) ${prose.slice(0, 6).join(', ')} — a comment terminator is probably misplaced`)
      : ok('no bare prose lines in the stylesheet');
  }
}

/* ── 3. v7.16 structural asserts ───────────────────────────────────────── */
console.log('[3] v7.16 structural asserts');
const has = (needle, label) => src.includes(needle) ? ok(label) : bad(label, 'missing: ' + needle);
const lacks = (needle, label) => !src.includes(needle) ? ok(label) : bad(label, 'still present: ' + needle);
has(`'2':{title:'2-POTENTIAL', ids:[10], full:true}`, 'GRID_SCOPES has 2-POTENTIAL → status idx 10, full editor');
has(`'4':{title:'4-REVIEW', ids:[9], full:true}`, 'GRID_SCOPES has 4-REVIEW → status idx 9, full editor');
has(`'5a':{title:'5-APPROVED', ids:[2,4,105], full:true}`, 'GRID_SCOPES 5a unchanged (2,4,105) + full flag');
has(`sc.interview ? 'openInterviewEditor' : (sc.full ? 'openApprovedEditor' : 'openKanbanModal')`, 'tile routing driven by scope (interview/full/kanban)');
/* v7.30 asserts: interview picture grid */
has('v7.30:', 'v7.30 deploy marker present');
has("'3':{title:'3-INTERVIEW', ids:[7], full:true, interview:true}", 'interview scope added to GRID_SCOPES');
has('async function openInterviewEditor(id)', 'openInterviewEditor present');
has("buildSidebarNav('interview');", 'interview editor builds interview sidebar');
has('const backToInterviewGrid = backToApprovedGrid', 'interview back-to-grid delegates to shared handler');
has("if(mode==='3'){", 'setMode has a dedicated interview-grid branch');
has("setGridScope('3');", 'interview branch sets grid scope 3');
/* v7.31 asserts: interview field navigator + new-model scraper move */
has('v7.31:', 'v7.31 deploy marker present');
has('const IV_QUESTION_MAP', 'interview question map present');
has("qw.style.display=(type==='full'||type==='interview')", 'interview sidebar shows the field search box');
has('IV_QUESTION_MAP.forEach', 'interview sidebar builds field list from IV_QUESTION_MAP');
has("['General Notes','iv-general-notes']", 'interview map targets real iv field ids');
has("['Legal Name','ive-text_mknceqty']", 'interview map includes extra-section fields');
lacks("d.dataset.ivSection='quick'", 'old quick/extra toggle nav removed');
has('if(!fvOn && !ivOn) return;', 'scroll-spy runs in interview editor too');
has(`if(mode==='5a'||mode==='2'||mode==='4'){`, 'setMode routes 2/4/5a to the grid');
has(`setGridScope(mode);`, 'setMode passes the mode as grid scope');
has("blk.style.display='';   // v7.27", 'shoot-tags editor block shows in every full-editor view');
has(`const on=false;`, 'Port row control retired from grids (#3)');
has(`scope:'5a'`, 'Shoot Tags FILTER stays 5-APPROVED-only');
has(`'2':{filters:{},search:'',sort:'date-desc'}`, 'amState has per-tab memory for 2');
has(`'4':{filters:{},search:'',sort:'date-desc'}`, 'amState has per-tab memory for 4');
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
has(`async function portShowPlan(models, typeOf, subtitle, planFn)`, 'shared portShowPlan exists (with plan builder)');
has(`await portShowPlan(models, null,`, 'portOpen routes through portShowPlan (role-based)');
has(`slots=>sbBuildPlan(entries, slots)`, 'sandbox port uses order-based plan (column placement = type)');
has(`.port-name-input`, 'port preview names are editable inputs'); 
has(`if(a.mode==='fill' && a.origName!==a.slotName) cvObj.name=a.slotName;`, 'fill-mode rename on edited names');
has(`function kbOpenRecrop()`, 'kanban-modal recrop entry exists');
has(`✂ Recrop</button>`, 'kanban-modal has the ✂ Recrop button');
has(`async function openRecrop(itemIdArg, headIdArg)`, 'openRecrop generalized for modal callers');
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
/* v7.19 asserts */
has('v7.19:', 'v7.19 deploy marker present');
has("['kanban-loading','am-loading','sb-loading']", 'loadKanban drives the sandbox loader');
has("['kanban-load-status','am-load-status','sb-load-status']", 'loadKanban sets the sandbox status text');
has('id="sb-loading"', 'sandbox loader element present');
has('id="sb-load-status"', 'sandbox load-status element present');
has('if(!kanbanItems.length){ if(ld) ld.style.display=\'\'; empty.style.display=\'none\'; board.style.display=\'none\'; return; }', 'renderSandbox defers to the spinner during load');
lacks("empty.textContent='Loading board…'", 'old static "Loading board…" removed');
/* v7.20 asserts */
has('v7.20:', 'v7.20 deploy marker present');
has('const SB_MIN_SLOTS=8', 'fixed 8-slot minimum');
has("zones:{b:[],v:[],t:[],ab:[],av:[],at:[]}", 'per-column alternates zone model (v7.22)');
has("const SB_TYPE={b:'BOTTOM',v:'VERSE',t:'TOP',ab:'ALTERNATE',av:'ALTERNATE',at:'ALTERNATE'};", 'zone→TYPE map has per-column alts');
has('function sbNormalizeZones(z)', 'zone normalizer present');
has("if(Array.isArray(z.alt)) out.av=out.av.concat", 'legacy single-alt migrates into verse alternates');
has('function sbBuildPlan(entries, slots)', 'order-based sandbox plan builder present');
has('function sbMove(id,zone,index)', 'sbMove is index-aware');
has('function sbDropSlot(e)', 'per-slot drop target present');
has('async function portShowPlan(models, typeOf, subtitle, planFn)', 'portShowPlan accepts a plan builder');
has('slots=>sbBuildPlan(entries, slots)', 'sandbox port uses the order-based plan');
has('a.replaces?` <span class="port-skip">(replaces', 'preview shows relink replacements');
has('class="sb-slot ', 'fixed slot elements rendered');
has('.sb-slotnum{', 'slot number badge CSS present');
has('sb-altzone', 'per-column alternate zones present (v7.22)');
/* v7.21 asserts (save states) */
has('v7.21:', 'v7.21 deploy marker present');
has("const SANDBOX_SAVES_BOARD_ID='18420711215';", 'saves board id present (client)');
has('async function sbEnsureSavesCol()', 'saves column auto-discovery present');
has("c.type==='long_text'", 'discovers a long_text column by type');
has('async function sbSaveState()', 'save-state function present');
has('create_item(board_id:$b,item_name:$n,column_values:$c)', 'save creates a Monday item');
has('function sbLoadSaves(force)', 'saved-states loader present');
has('function sbLoadSave(id)', 'load-a-save present');
// v7.71 split the single Save button into Update / Save-as-new; sbSaveState() is kept as a
// back-compat shim that picks the right branch. Assert the shim and both wired buttons.
has('async function sbSaveState(){ return sbCurrentSaveId ? sbUpdateCurrentSave() : sbSaveStateAsNew(); }', 'sbSaveState kept as a branching shim');
has('onclick="sbUpdateCurrentSave()"', 'Update button wired');
has('onclick="sbSaveStateAsNew()"', 'Save-as-new button wired');
has('id="sb-saves-list"', 'saved-states strip present');
has('sbLoadSaves(false);', 'saves load when sandbox opens');
/* v7.22 asserts (per-column alternates) */
has('v7.22:', 'v7.22 deploy marker present');
has("const SB_ALT={b:'ab',v:'av',t:'at'};", 'per-column alternates map present');
has('const SB_MIN_SLOTS=8, SB_ALT_MIN=4;', 'main/alt slot minimums');
// v7.71: alternates are no longer inside each column — they are three rows in one collapsible
// block below the primary rows. Still labelled per role, which is what this assert now guards.
has("label+' ALTERNATES'", 'alternates rows still labelled per role');
// v7.72: the Port alternate numbering used a hardcoded ['ab','av','at'] that stopped matching the
// on-screen order once the rows were reordered to TOP/BOTTOM/VERS. It now derives from SB_MAIN, so
// assert the derivation AND that the stale literal is gone — that pairing is the actual guarantee.
has("SB_ALT_ORDER.forEach(z=>(sbState.zones[z]||[]).forEach(id=>{ const m=byId[id]; if(m){ altNum++;", 'alternates numbered at port in DISPLAY order');
has('const SB_ALT_ORDER=SB_MAIN.map(([z])=>SB_ALT[z]);', 'port alternate order derived from SB_MAIN, not hand-written');
lacks("['ab','av','at'].forEach", 'the hardcoded alternates order is gone');
has('const slots=(z,alt)=>', 'slot renderer takes an alt flag');
/* v7.23 asserts */
has('v7.23:', 'v7.23 deploy marker present');
has('function sbAskDeleteSave(id)', 'save delete-confirm present');
has('async function sbDoDeleteSave()', 'save delete executor present');
has('delete_item(item_id:$i)', 'delete uses delete_item');
has('id="sb-del-modal"', 'delete-confirm box present');
has('onclick="event.stopPropagation();sbAskDeleteSave', 'delete button per saved state');
has('function copyModelLink()', 'model deep-link copy present');
has('async function openModelDeepLink(id)', 'model deep-link open present');
has("startsWith('#model=')", 'boot handles #model= links');
has('id="copy-model-link-btn"', 'copy-link button present');
has("date:{key:'addedTs',raw:'addedLabel',label:'date added'}", 'date-added sort field present');
has('async function resolveDateInputCol()', 'DATE INPUT column discovery present');
has("x.type==='date' && /date\\s*input/i.test", 'discovers DATE INPUT by title/type');
has('if(!isFinite(addedTs)) addedTs = Date.parse(it.created_at', 'date falls back to created_at');
has('items{id name created_at updated_at column_values', 'bulk load fetches created_at');
has('<option value="date-desc">', 'date sort option in dropdown');
/* v7.24 asserts (duplicate stage-name twins) */
has('v7.24:', 'v7.24 deploy marker present');
has('function hasStageNameFlag(name)', 'stage-name-flag detector present');
has('function dupNameKey(name)', 'dup grouping-key normalizer present');
has('const k=dupNameKey(it.name);', 'dedup groups by normalized key');
has('const flagged = group.items.filter(i=>hasStageNameFlag(i.name));', 'keeper prefers flagged row');
has('const pool = flagged.length ? flagged : group.items;', 'keeper falls back when none flagged');
lacks('const k=it.name.toLowerCase(); (byName', 'old exact-name grouping removed');
/* v7.25 assert (merge guardrail matches grouping) */
has('v7.25:', 'v7.25 deploy marker present');
has('const names = new Set(group.items.map(it=>dupNameKey(it.name)));', 'merge guardrail uses normalized key');
lacks("const names = new Set(group.items.map(it=>it.name.trim().toLowerCase()));", 'old exact-name guardrail removed');
/* v7.26 asserts (ignore + keep-one) */
has('v7.26:', 'v7.26 deploy marker present');
has('async function ignoreGroup(gid)', 'persistent ignore present');
has('async function executeKeepOnly(gid)', 'keep-one-delete-rest present');
has("const DUP_IGNORE_NAME='__DUP_IGNORE__';", 'ignore list item name');
has('function dupSig(group)', 'id-set signature present');
has('.filter(g => !dupIgnoreSet.has(dupSig(g)))', 'ignored groups filtered from scan');
has('await dupLoadIgnore();', 'ignore list loaded on scan');
has('onclick="executeKeepOnly(', 'keep-one button wired');
has('onclick="ignoreGroup(', 'not-a-duplicate button wired');
/* v7.27 asserts */
has('v7.27:', 'v7.27 deploy marker present');
has("all:{title:'All Models', ids:null, full:true}", 'All Models opens full editor');
has("fv.insertBefore(blk, notes && notes.nextSibling", 'shoot tags relocated + shown in full editor');
has('src="/logo-carnal.png"', 'logo image used in header');
has('class="pw-logo-img"', 'logo image on login screen');
has("--font-display:'Myriad Pro','Source Sans 3',sans-serif", 'heading font is Myriad Pro/Source Sans 3');
has('family=Source+Sans+3', 'Source Sans 3 loaded');
lacks("family=Syne", 'old Syne font removed');
has('let suppressDirty = false;', 'dirty guard flag present');
has('if(suppressDirty) return;', 'markDirty respects the load guard');
has('suppressDirty=true;   // v7.27', 'guard engaged on load');
/* v7.28 asserts */
has('v7.28:', 'v7.28 deploy marker present');
has("fv.insertBefore(blk, notes && notes.nextSibling", 'shoot tags lifted to top of editor');
has('async function scrapePhotos(ctx, fresh)', 'scrape entry present (v7.63: fresh flag)');
has('async function scrapeImport()', 'scrape import present');
has("fetch('/scrape-images?url='", 'calls scrape endpoint');
has("fetch('/proxy-image?url='", 'downloads via image proxy');
has('addPhotos([file],hsSlot)', 'scraped headshot uses the normal upload path');
has('id="scrape-modal"', 'scrape picker modal present');
has('onclick="scrapePhotos(\'fv\')"', 'scrape button wired (fv)');
/* v7.29 asserts */
has('v7.29:', 'v7.29 deploy marker present');
// (1) scrape in three contexts
has("const SCRAPE_TYPES={fv:['fv-headshot','fv-extra'], iv:['iv-headshot','iv-extra'], new:['headshot','extra']}", 'SCRAPE_TYPES map present');
has('id="scrape-url-fv"', 'fv scrape input renamed');
has('id="scrape-url-iv"', 'interview scrape input present');
has('id="scrape-url-new"', 'new-model scrape input present');
has('onclick="scrapePhotos(\'iv\')"', 'interview scrape button wired');
has('onclick="scrapePhotos(\'new\')"', 'new-model scrape button wired');
has('const [hsSlot, exSlot]=SCRAPE_TYPES[scrapeCtx]', 'scrapeImport routes via SCRAPE_TYPES');
// (2) sandbox notes + port
has('notes:{}', 'sbState carries notes');
has('n:sbState.notes', 'notes encoded into share link');
has('function sbNormalizeNotes(', 'notes normalizer present');
has('sbNormalizeNotes(p&&p.n)', 'notes restored from share link');
has('sbNormalizeNotes(s.data.notes)', 'notes restored from saved state');
has('notes:sbState.notes', 'notes persisted in save-state payload');
has('class="sb-note-caret', 'note caret rendered on tiles');
has('function sbOpenNote(', 'sbOpenNote present');
has('function sbSaveNote(', 'sbSaveNote present');
has('id="sb-note-modal"', 'note modal present');
has("if(a.pay) cvObj['text_mm522jb4']=a.pay", 'port writes Pay information column');
has("if(a.dates) cvObj['long_text_mm35h07x']={text:a.dates}", 'port writes Dates Booked column');
has('mode:\'fill\', slotId:slot.id, slotName:slot.name, replaces:rep, pay, dates', 'fill action carries pay/dates');
has('mode:\'create\', slotName:desired, pay, dates', 'create action carries pay/dates');
// (3) deferred stage-name save
has('function stageNameEdited(', 'stageNameEdited present');
has('async function applyStageNameOnSave(', 'applyStageNameOnSave present');
has('Stage name changed — hit Save to apply', 'deferred stage-name toast present');
has("if(currentMode!=='new' && currentItem){ await applyStageNameOnSave(); }", 'saveAll applies deferred stage name');
has('onblur="stageNameEdited(this.value)"', 'stage-name inputs use deferred handler');
lacks('onblur="updateItemName(this.value)"', 'old immediate-write stage-name handler removed');
// Guard against duplicate element ids from the toolbar rebuild:
['am-title','am-search','am-sort','am-count','am-filterbtns','port-wrap','port-tag','port-btn','port-row-btn','port-row-picker','port-row-search','port-row-list',
 'sb-view','sb-tag','sb-count','sb-board','sb-empty','sb-row-btn','sb-row-picker','sb-row-search','sb-row-list','sb-progress','sb-loading','sb-load-status'].forEach(id=>{
  const c = (src.match(new RegExp('id="' + id + '"', 'g')) || []).length;
  c === 1 ? ok(`id "${id}" unique`) : bad(`id "${id}" appears ${c} times`);
});

/* v7.32 asserts: wire speed */
has('v7.32:', 'v7.32 deploy marker present');
has("'limit:500'", 'board pager uses limit:500');
has("sessionStorage.getItem('dateInputColId:'", 'date-input column id cached in session');
has('rel="preconnect" href="https://fonts.gstatic.com"', 'font preconnect hint present');

/* v7.33 asserts: tabs speed (store-derived candidate lists) */
has('v7.33:', 'v7.33 deploy marker present');
has('BOARD_ID===MAIN_BOARD_ID && kbLoadedOnce && kanbanItems.length', 'mode lists derive from shared store');
lacks('id public_url url_thumbnail', 'blurry url_thumbnail grid fetch NOT present (reverted)');
lacks('kbThumbCache', 'thumbnail cache NOT present (reverted)');
lacks('function kbThumb(', 'kbThumb helper NOT present (reverted)');

/* v7.34 asserts: med-thumb read side */
has('v7.34:', 'v7.34 deploy marker present');
has('const MED_THUMB_HEAD_COL', 'headshot med-thumb column map present');
has('const MED_THUMB_EXTRA_COL', 'extra med-thumb column map present');
has("'18419204393': 'file_mm54s1b9'", 'staging headshot med-thumb col mapped');
has('function gridImgAsset(', 'grid image asset resolver present');
has('const medCol = medHeadCol(); if(medCol) colIds.push(medCol)', 'loadKanban fetches headshot med-thumb col');
has('let medHead=null;', 'medHead parsed per model');
has('medThumbUrlBySource', 'editor strip pairs extras to med-thumbs');
has('medthumb-(\\d+)\\.jpg', 'pairing keys off embedded source asset id');

/* v7.35 asserts: med-thumb write side */
has('v7.35:', 'v7.35 deploy marker present');
has('async function makeMedThumb(', 'makeMedThumb generator present');
has('async function setHeadMedThumb(', 'setHeadMedThumb helper present');
has('async function clearHeadMedThumb(', 'clearHeadMedThumb helper present');
has('async function addExtraMedThumb(', 'addExtraMedThumb helper present');
has('return j?.data?.add_file_to_column?.id', 'uploadFileToMonday returns new asset id');
has('await setHeadMedThumb(newId, file)', 'new-model headshot generates med-thumb');
has('addExtraMedThumb(newId, file, exId)', 'new-model extras generate paired med-thumbs');
has('await setHeadMedThumb(job.itemId, file, bId)', 'headshot-replace regenerates med-thumb (v7.44: in runPhotoJob, board-threaded)');
has('await clearHeadMedThumb(itemId, bId)', 'recrop clears head med-thumb (fallback to full; v7.45 board-threaded)');
has('`medthumb-${fullAssetId}.jpg`', 'extra med-thumb named by source asset id (pairing)');

/* v7.36 asserts: med-thumb hardening + scrape UX */
has('v7.36:', 'v7.36 deploy marker present');
has('async function clearExtraMedThumbs(', 'clearExtraMedThumbs helper present (Finding 1)');
has('setTimeout(r, 800)', 'setHeadMedThumb settles after clear (Finding 2)');
has('if(hasExisting)', 'setHeadMedThumb only clears when column non-empty (Finding 2)');
has('await Promise.allSettled(medThumbJobs)', 'extras thumbs run in parallel (v7.44: unified in runPhotoJob for iv+fv)');
has('Promise.allSettled(nmMedThumbJobs)', 'new-model extras thumbs run in parallel (Finding 3)');
{ const n2=(src.match(/clearExtraMedThumbs\(/g)||[]).length;
  (n2>=5 ? ok : bad)(`clearExtraMedThumbs still guards the flows that DO churn extras (${n2} calls; v7.40 dropped the 2 replace flows to the fast path)`, `only ${n2}`); }
has("['f-dup__of_facebook','f-lien_internet']", 'scrape falls back to saved Bluesky then Twitter/X link');
{ const btn=src.indexOf('id="scrape-btn-fv"'), inp=src.indexOf('id="scrape-url-fv"');
  (btn>0 && inp>0 && btn<inp ? ok : bad)('scrape button now left of URL field (fv)', 'button not before input'); }

/* v7.36.1 asserts: scrape fixes */
has('v7.36.1:', 'v7.36.1 deploy marker present');
has("['scrape-url-fv','scrape-url-iv','scrape-url-new'].forEach", 'scrape fields cleared on model load');
has('let usingSaved = false', 'auto-Bluesky no longer writes into the field');
lacks("if(f) f.value = saved; // show what we're scraping", 'old field-write behavior removed');

/* v7.36.2 assert: broadened Bluesky extraction (server.js) */
{ const srv = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  (srv.includes('if(v.thumbnail) push') && srv.includes('e.external || (e.media && e.media.external)') ? ok : bad)
    ('v7.36.2 Bluesky scrape harvests video + external + recordWithMedia thumbs', 'server extraction not broadened'); }

/* v7.36.3 asserts: scrape picker UX */
has('v7.36.3:', 'v7.36.3 deploy marker present');
has('function scrapeSelectAll(', 'select all/none helper present');
has('function scrapeSyncHsAvailability(', 'headshot availability sync present');
has('onclick="scrapeSelectAll(false)"', 'Select none button wired');
has('type="checkbox" class="scrape-hsr"', 'headshot is a checkbox (not radio)');
lacks('type="radio" name="scrape-hs"', 'old forced-radio headshot removed');
has('let hsIdx = hsEl ? Number(hsEl.dataset.i) : -1', 'import allows zero headshot');

/* v7.36.4 assert: proxy-image byte sniffing (server.js) */
{ const srv = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  (srv.includes('const sniff = (b)=>{') && srv.includes("ct = sniffed") ? ok : bad)
    ('v7.36.4 /proxy-image sniffs mislabelled image bytes', 'proxy-image sniff not present'); }

/* v7.37 asserts: grid/tab tweaks */
has('v7.37:', 'v7.37 deploy marker present');
has('id="iv-shoot-tags-block"', '#1 interview shoot-tags block present');
has('function ivShootPickerPick(', '#1 interview shoot-tag picker present');
has("const ivc=document.getElementById('iv-shoot-boxes')", '#1 chips mirror to interview view');
has('id="sb-tag-picker"', '#2 sandbox tag searchable picker present');
has('function sbRenderTagList(', '#2 sandbox tag list renderer present');
lacks('onchange="sbTagChanged()"', '#2 old plain sandbox tag select removed');
has('const on=false;', '#3 port control hidden on 5-APPROVED');
{ const n=(src.match(/sort:'date-desc'/g)||[]).length;
  (n>=5 ? ok : bad)(`#4 grids default to newest-first (${n} scopes)`, `only ${n}`); }
has('grp===CASTING_TOP_GROUP && cv && cv.index===0', '#6 port rows = CASTING only (no CREW)');
lacks('cv.index===0 || cv.index===4', '#6 old CASTING+CREW filter removed');

/* v7.37.1 assert: shoot-tag save not gated to 5a-only */
has("if(shootTagsDirty && currentMode!=='new' && String(BOARD_ID)===String(MAIN_BOARD_ID))", 'v7.37.1 shoot-tag save fires from interview view too');
lacks("if(shootTagsDirty && currentMode==='5a'", 'v7.37.1 stale 5a-only shoot-tag gate removed');

/* v7.37.2 asserts: sandbox scope broadened */
has('v7.37.2:', 'v7.37.2 deploy marker present');
has('const SB_EXCLUDE_STATUS = new Set([3,0,6,11,12])', 'sandbox excludes rejected/retired/delete/evernote/dup');
has('!SB_EXCLUDE_STATUS.has(m.statusIdx)', 'sandbox filters by exclusion, not approved-only');
lacks("GRID_SCOPES['5a'].ids.includes(m.statusIdx) && m.f && Array.isArray(m.f.shoot)", 'old approved-only sandbox filter removed');

/* v7.38 asserts: editable grid */
has('v7.38:', 'v7.38 deploy marker present');
has('let gridEdits = {}', 'grid edits buffer present');
has('function gridSetRating(', 'inline rating editor present');
has('function gridToggleTag(', 'inline shoot-tag editor present');
has('function gridSaveAll(', 'grid batch save present');
has('function gridGateOpen(', 'conflict gate present');
has('numeric_mm1z34ca","numeric_mm1zjjrp"', 'loadKanban fetches rating columns');
has("rIntake:num('numeric_mm1z34ca'),rFinal:num('numeric_mm1zjjrp')", 'ratings parsed into store');
has("['numeric_mm1zjjrp']: val", 'grid saves Final rating column');
has('gridEdits={};   // v7.38: board reloaded', 'stale grid edits cleared on reload');
has('|| kbModalDirty() || gridHasEdits()', 'beforeunload warns on grid edits');

/* v7.38.1 asserts: editable-grid tile fix */
has('v7.38.1:', 'v7.38.1 deploy marker present');
lacks('<span class="am-caret">', 'stray tile caret removed');
has('Date created', 'DATE CREATED label row present');
has('.am-tile.picker-open{overflow:visible', 'tile escapes clip while picker open');
has('function gridToggleTagList(', 'grid tag list popover present');
has('tile.classList.add(\'picker-open\')', 'picker toggle sets picker-open');

/* v7.39 asserts: rating step + sandbox polish + UX steps */
has('v7.39:', 'v7.39 deploy marker present');
has('step="1"', 'grid rating steps by whole integers');
has("filled>0?'partial'", 'sandbox note caret is 3-state (v7.49: 4-field)');
has('.sb-note-caret.note-partial', 'yellow partial note state CSS present');
has('.sb-note-caret.note-both', 'green complete note state CSS present');
has('class="sb-step-num">1<', 'sandbox step 1 present');
has('class="sb-step-num">4<', 'sandbox step 4 present');
has('Send to casting row', 'port button relabeled friendly');
lacks('⇪ Port this arrangement', 'old dense port label removed');

/* v7.40 asserts: grid shoot-tag filter + tag-count + fast headshot + sandbox add-model */
has('v7.40:', 'v7.40 deploy marker present');
lacks("label:'Shoot Tags', kind:'dropdown', scope:'5a'", 'shoot-tag filter no longer scope-locked to 5a');
has("label:'Shoot Tags', kind:'dropdown'}", 'shoot-tag filter present on all grids');
has('am-tag-count', 'grid tag-count badge present');
has('function gridToggleTagList(', 'grid tag list popover present');
has('function replaceHeadshotFast(', 'fast headshot client helper present');
has('function sbOpenAddPicker(', 'sandbox empty-slot add picker present');
has('function sbAddPick(', 'sandbox add-model pick handler present');
has('const SB_EXCLUDE_STATUS = new Set([3,0,6,11,12])', 'sandbox exclude set hoisted to module scope');
/* server.js */
{ const srv = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  (srv.includes('/replace-headshot-fast') ? ok : bad)('fast headshot server endpoint present', 'missing /replace-headshot-fast');
  (srv.includes('[HEADSHOT_COL]: { clear_all: true }') ? ok : bad)('fast endpoint clears only headshot column', 'missing headshot-only clear'); }

/* v7.41 asserts: theme + quick-UI batch */
has('v7.41:', 'v7.41 deploy marker present');
has('--accent:#3AA2E0', 'accent recolored to logo blue');
lacks('#a78bfa', 'no purple accent fallbacks remain');
lacks('#c8b4ff', 'old purple accent var gone');
has('border:1px solid #f5c518;color:#f5c518', 'scrape button is yellow');
has("border:2px solid #fff !important", 'measurement source-of-truth white outline');
has('function measInferSrc(', 'source-of-truth inference present');
has('function measMarkSrc(', 'live source marking present');
has('is outside the plausible range', 'clearer out-of-range metric warning');
has('class="meas-pair"', 'paired imperial|metric rows present');
has("addEventListener('click', e=>{", 'capture-phase close handler present');
has('am-taglist-add', 'tag list + Add tag footer present');
has('.kb-chk:has(input:checked)', 'kanban multi restyled as box buttons');
has('recrop-guide', 'recrop head+shoulders guide present');
has('function toggleRecropGuide(', 'recrop guide toggle present');

/* v7.42 asserts: sandbox bigger tiles + tile→editor round trip */
has('v7.42:', 'v7.42 deploy marker present');
has('width:128px;height:128px', 'sandbox thumb enlarged to 128px');
has('minmax(320px,1fr)', 'sandbox columns widened');
has('sb-edit-btn', 'sandbox tile edit button present');
has('function sbOpenFullEditor(', 'sandbox→full-editor opener present');
has("editorReturnTo==='sb'", 'back-to-grid returns to sandbox');
has('let editorReturnTo', 'editorReturnTo state present');

/* v7.43 asserts: kanban drag-to-change-status */
has('v7.43:', 'v7.43 deploy marker present');
has('function kbDragStart(', 'kanban card dragstart handler');
has('function kbDrop(', 'kanban column drop handler');
has('function kbDragOver(', 'kanban dragover handler');
has('draggable="true" ondragstart="kbDragStart', 'kanban cards are draggable');
has('ondrop="kbDrop(event', 'kanban columns are drop targets');
has('KANBAN_COLS[i].ids[0]', 'drop writes column primary status id');
has('kb-drop-over', 'drop-target highlight style present');

/* v7.44 asserts: background non-blocking photo uploads */
has('v7.44:', 'v7.44 deploy marker present');
// queue + serialization
has('let bgJobs = [];', 'bgJobs queue present');
has('const bgRunning = new Set()', 'photo-job run guard present');
has('function enqueuePhotoJob(', 'photo job enqueue present');
has('function pumpBgJobs(', 'job pump present');
has('async function runPhotoJob(', 'runPhotoJob worker present');
has('function hasActivePhotoJob(', 'active-job check present');
has('boardId: String(extra.boardId)', 'job snapshots active board at enqueue');
// board threading (a mid-job board switch must not retarget the write)
has('function medHeadCol(bId)', 'medHeadCol accepts optional boardId');
has('function medExtraCol(bId)', 'medExtraCol accepts optional boardId');
has('async function setHeadMedThumb(itemId, sourceFile, bId)', 'setHeadMedThumb board-threaded');
has('async function addExtraMedThumb(itemId, sourceFile, fullAssetId, bId)', 'addExtraMedThumb board-threaded');
has('async function replaceHeadshotFast(itemId, newHeadAssetId, oldHeadAssetIds, bId)', 'replaceHeadshotFast board-threaded');
has('await replaceHeadshotFast(job.itemId, newEntry.assetId, oldHead.map(e=>e.assetId), bId)', 'runPhotoJob passes snapshotted board to fast replace');
// save path is now non-blocking (enqueue, no overlay)
has('enqueuePhotoJob({itemId, modelName:name, boardId, headshotFile, extraFiles})', 'save enqueues a background photo job');
lacks("prog.classList.add('visible')", 'blocking upload overlay is no longer shown by the save path');
// completion: refresh store (head AND medHead), drop stale cache, repaint tile
has('async function refreshItemHeadFromMonday(', 'completion store refresh present');
has('m.medHead = medAsset', 'completion updates medHead (not just head)');
has('delete kbHeadCache[String(m.head)]', 'completion drops stale head cache entry');
// widget
has('id="bgjobs"', 'jobs widget container present');
has('function renderBgJobs(', 'jobs widget renderer present');
has('function retryBgJob(', 'failed-job retry present');
has('function flashBgJobRow(', 'done-flash present');
has('bgjob-retry', 'retry button styled');
// beforeunload + in-progress note
has('const photoJobsActive', 'beforeunload warns while jobs active');
has('photo-inflight-note', 'in-progress note styled');
has('function refreshInflightNotes(', 'in-progress note toggler present');
has('iv-photo-inflight', 'iv in-progress note present');
has('fv-photo-inflight', 'fv in-progress note present');

/* v7.45 asserts: recrop → background queue + cancelable jobs + global serialization */
has('v7.45:', 'v7.45 deploy marker present');
// recrop routed through the queue
has('function enqueueRecropJob(', 'recrop enqueue helper present');
has('async function runRecropPhase(', 'recrop background worker present');
has('async function runSavePhase(', 'save background worker present');
has('enqueueRecropJob({ itemId, modelName:name, boardId:BOARD_ID, croppedFile:file, headId })', 'saveRecrop enqueues instead of uploading inline');
has("job.kind==='recrop'", 'runPhotoJob branches on job kind');
lacks("st.textContent='Setting as headshot on Monday", 'recrop no longer runs the rearrange inline in saveRecrop');
// global one-at-a-time serialization
has('function bgAnyRunning(', 'global run check present');
has('if(bgAnyRunning()) return;', 'pump enforces global concurrency = 1');
// cancel (honest phase gating)
has('function cancelBgJob(', 'job cancel present');
has('function bgJobCancelable(', 'cancelable-phase check present');
has("job._phase==='finalizing'", 'cancel refused during the atomic finalize phase');
has('job._canceled = true', 'cancel flags the job and aborts the transfer');
has("xhr.onabort = () => reject(new Error('canceled'))", 'upload xhr abort wired');
has('onXhr(xhr)', 'uploadFileToMonday exposes the xhr for abort');
has('bgjob-cancel', 'widget cancel button styled');
has("status==='canceled'", 'canceled job status handled in widget');
// board threading for the recrop write helpers
has('async function rearrangePhotos(itemId, headshotAssetIds, extraAssetIds, bId)', 'rearrangePhotos board-threaded');
has('async function clearHeadMedThumb(itemId, bId)', 'clearHeadMedThumb board-threaded');
has('async function clearExtraMedThumbs(itemId, bId)', 'clearExtraMedThumbs board-threaded');
has('await rearrangePhotos(itemId,[newId],[oldHead,...extrasBefore].filter(x=>x!=null), bId)', 'recrop rearrange uses snapshotted board');

/* v7.46 asserts: change-headshot → queue, kanban drop zones, new sandbox shoot tag */
has('v7.46:', 'v7.46 deploy marker present');
// (A) change headshot → background queue
has('function enqueueChangeHeadJob(', 'change-headshot enqueue helper present');
has('async function runChangeHeadPhase(', 'change-headshot background worker present');
has("job.kind==='changehead'", 'runPhotoJob branches on changehead kind');
has('enqueueChangeHeadJob({ itemId:String(id), modelName:nm, boardId:BOARD_ID, assetId })', 'saveKanbanCard enqueues the headshot change (non-blocking)');
lacks('await kbApplyHeadshot(id);', 'change-headshot no longer applied inline/blocking in saveKanbanCard');
// (B) kanban drop zones
has('align-items:stretch', 'kanban columns stretch to equal height');
has('flex:1 1 auto;min-height:140px', 'kanban column body fills the column (large drop target)');
// (C) new shoot tag from the sandbox
has('function sbNewTag(', 'sandbox new-tag creator present');
has('if(sbState.pendingLabel) return sbState.pendingLabel;', 'provisional tag label resolves before Monday id exists');
has('if(!sbState.tag && !sbState.pendingLabel)', 'renderSandbox accepts a provisional tag');
has('sb-newtag', 'the + New tag row is rendered/styled');
has("String(sbState.pendingLabel).toLowerCase()===label.toLowerCase()", 'provisional tag is promoted to a real id after first add');

/* v7.47 asserts: dead-code removal + grid tag "+" on every tile + recrop shoulder guide */
has('v7.47:', 'v7.47 deploy marker present');
// (A) dead change-headshot code removed
lacks('function kbApplyHeadshot(', 'dead kbApplyHeadshot removed');
lacks('function kbHsProgressStart(', 'dead kbHsProgressStart removed');
lacks('kbHsTimer=setInterval', 'dead kbHsTimer loop removed');
lacks('.kb-hs-prog-bar{', 'dead kb-hs-prog CSS removed');
// (B) grid tag picker reachable in one click on every tile
has('function gridTagCountClick(', 'grid count uses live read-only/picker branch');
has('.am-tag-count.empty{color:var(--text-dim);cursor:pointer}', 'empty No-tags count is clickable');
// (C) recrop shoulder guide raised onto the shoulder line
has('M8,77 C26,66 74,66 92,77', 'shoulder guide curve position (v7.49)');
lacks('M6,90 C22,66 78,66 94,90', 'v7.47 (still-too-low) shoulder curve removed');
lacks('M8,100 C20,78 80,78 92,100', 'old low shoulder curve removed');

/* v7.48 asserts: grid "+" cutoff fix + recrop shoulder guide (recomputed) */
has('v7.48:', 'v7.48 deploy marker present');
has('.am-tags-row .am-flabel{width:44px}', 'tag-row label narrowed so the + fits');
has('flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', 'tag count shrinks before the + clips');
has('.am-tags-row{position:relative;padding-bottom:2px;gap:6px}', 'tag row gap tightened');
// (recrop shoulder path already asserted above at the updated value)

/* v7.49 asserts: 6 feedback items */
has('v7.49:', 'v7.49 deploy marker present');
// (B) 4-corner recrop resize
has('.recrop-handle.tl{', 'recrop corner handles styled');
has('data-corner="tl"', 'recrop corner handles present');
has("d.corner==='bl'", 'corner-aware resize keeps opposite corner fixed');
// (C) tag count read-only vs picker (live branch)
has('function gridTagCountClick(', 'grid count uses live read-only/picker branch');
has('gridTagCountClick(', 'count button wired to gridTagCountClick');
// (D) tag order — v7.69 replaced alphabetical with newest-created-first. monday gives no created-at
// for dropdown labels, so descending label id is the recency proxy. Applied tags pin above the rest.
has('.sort((a,b)=>Number(b.id)-Number(a.id))', 'grid tag options sorted newest-created first (descending label id)');
has('const applied=opts.filter(l=>current.has(l.toLowerCase()))', 'applied tags partitioned out of the picker list');
has('const rest=opts.filter(l=>!current.has(l.toLowerCase()))', 'unapplied tags listed after the applied ones');
has('order.indexOf(a)-order.indexOf(b)', 'read-only tag popover reuses the picker ordering');
// (D2) v7.69 — content-visibility:auto applies implicit PAINT CONTAINMENT, which clips the tag
// popovers even with overflow:visible. The open tile must lift it or both popovers render invisible.
has('.am-tile.picker-open{overflow:visible;z-index:40;content-visibility:visible}', 'open tile lifts content-visibility so tag popovers are not paint-clipped');
// (D3) v7.70 — sticky grid toolbars, scroll restore, grabbable scrollbar, back-to-top.
// #form-area is the ONLY scrolling element (html,body{overflow:hidden}), so every one of these
// must target it. window.scrollY is permanently 0; window.scrollTo() is a silent no-op.
has('.tb-sticky{position:sticky;top:-24px;z-index:45', 'pinned row offsets past #form-area padding so tiles cannot bleed above it');
has('margin:-24px -32px 10px;padding:32px 32px 8px', 'negative margin cancels the cover padding, keeping at-rest layout unchanged');
has('body.is-mobile .tb-sticky{top:-18px;margin:-18px -14px 10px', 'mobile offsets match the mobile #form-area padding');
has("parseFloat(getComputedStyle(fa).paddingTop)", 'save-bar offset derives padding from live computed style, not a second constant');
has('class="am-toolbar-row tb-sticky"', 'All Models controls row carries the sticky class');
has('am-toolbar am-toolbar-titleonly', 'title row split into its own wrapper so the controls row can be a direct child of #am-view');
has('.grid-save-bar{position:sticky;top:var(--tb-sticky-h,0px)', 'save bar offset tracks the pinned row height');
has('function tbSyncStickyOffset(', 'sticky offset is measured, not hardcoded');
has("style.setProperty('--tb-sticky-h'", 'measured row height published as a CSS variable');
has('function gridRememberScroll(', 'grid scroll position captured on editor open');
has('function gridRestoreScroll(', 'grid scroll position restored on back-to-grid');
has('gridScrollMemory[gridScope]', 'scroll memory keyed by grid scope so tabs cannot cross-restore');
has('gridRememberScroll();   // v7.70: capture BEFORE hiding the grid', 'capture happens before the grid is hidden');
has('gridRestoreScroll();   // v7.70', 'backToApprovedGrid restores scroll after re-render');
has('sbReturnScroll = faEl()?.scrollTop || 0', 'sandbox capture reads #form-area, not window.scrollY');
has('.form-area::-webkit-scrollbar{width:12px}', 'form-area scrollbar is grabbable (was 4px)');
has('.form-area::-webkit-scrollbar-thumb:hover', 'scrollbar thumb has a hover affordance');
has('scrollbar-color:var(--border-active,#3AA2E0) transparent', 'Firefox scrollbar styled too');
has('function faToggleTopBtn(', 'back-to-top visibility helper present');
has('function faScrollTop(', 'back-to-top action present');
has('id="to-top-btn"', 'back-to-top button in the markup');
has("addEventListener('scroll', faToggleTopBtn", 'back-to-top driven by the #form-area scroll event');
lacks('window.scrollTo(0, sbReturnScroll', 'the no-op window.scrollTo sandbox restore is gone');
// (D4) v7.71 — sandbox rows instead of columns, and save-in-place.
// Reminder: these are substring checks. The row geometry was verified by measuring a real browser
// fixture (one slot high, 8 slots on one line, horizontal scroll, last slot hit-testable).
has('.sb-zone.sb-rowzone{border:none;flex-wrap:nowrap;overflow-x:auto', 'row zone is one line with horizontal scroll');
has('.sb-rows{display:flex;flex-direction:column', 'zones stack vertically as rows');
has('.sb-altblock.collapsed .sb-rows{display:none}', 'alternates block is collapsible');
has('const row=(z,label,alt)=>', 'renderSandbox emits rows, not columns');
has("SB_MAIN.map(([z,label])=>row(SB_ALT[z], label+' ALTERNATES', true))", 'alternates render below, still split by role');
has('function sbToggleAlts(', 'alternates toggle present');
has("localStorage.setItem('sbAltCollapsed'", 'collapse state persisted as a view preference');
has('.sb-zone.sb-rowzone::-webkit-scrollbar{height:10px}', 'row scrollbar is grabbable, not the 4px default');
// save-in-place
has('let sbCurrentSaveId=null', 'the open save is tracked');
has('function sbUpdateCurrentSave(', 'update-in-place path exists');
has('function sbSaveStateAsNew(', 'save-as-new path exists');
has('function sbBuildSavePayload(', 'both save paths share one payload builder');
has('change_multiple_column_values(item_id:$i,board_id:$b,column_values:$c,create_labels_if_missing:false){id}}`,\n      {i:String(sbCurrentSaveId)', 'update writes to the existing save item');
has('sbClearCurrentSave();   // v7.71: fresh arrangement', 'tag change clears the open save');
has("sbClearCurrentSave();   // v7.71: a #sb= share link", 'share link does not adopt an open save');
has('if(String(sbDelId)===String(sbCurrentSaveId', 'deleting the open save clears the tracker');
has('id="sb-update-btn"', 'Update button in the markup');
has('id="sb-saveas-btn"', 'Save-as-new button in the markup');
has('.sb-save-chip.open', 'open save chip is visually marked');
// (D5) v7.72 — one-tap promote/demote + TOP/BOTTOM/VERS order
has("const SB_MAIN=[['t','TOP'],['b','BOTTOM'],['v','VERS']];", 'rows ordered TOP, BOTTOM, VERS');
has("const SB_ALT_REV={ab:'b',av:'v',at:'t'};", 'alternates→main reverse map present');
has('function sbBump(e,id){', 'one-tap promote/demote present');
has('const target = SB_ALT_REV[cur] || SB_ALT[cur];', 'bump direction derived from which zone the tile is in');
has('sbMove(id, target, null);', 'bump appends to the next free slot, reusing sbMove');
has('function sbZoneLabel(z){', 'zone label helper for the bump toast');
has('const tile=(id,alt)=>', 'tile knows whether it is in an alternates row');
has("tile(id,alt)", 'slot renderer passes the alt flag to the tile');
has('class="sb-bump-btn ${bumpUp?', 'bump button rendered with a direction class');
has("${bumpUp?'↑':'↓'}", 'arrow points up from alternates, down from a main row');
has('.sb-bump-btn{position:absolute;top:3px;left:3px', 'bump button sits top-left of the tile');
has('.sb-slot.filled .sb-slotnum{top:40px', 'slot label moved clear of the bump button on filled slots');
// (E) sandbox tab not clipped by toolbar style
has('.sb-btn:not(.mode-btn)', 'toolbar .sb-btn scoped away from the mode tab');
// (F) airport note fields → subitem port
has('sb-note-startair', 'beginning-airport field present');
has('sb-note-endair', 'end-airport field present');
has('startAirport:nt.startAirport', 'port entries carry airports');
has('SUBITEM_START_AIR_COL=', 'beginning-airport subitem col id (v7.50 hardcoded)');
has('cvObj[SUBITEM_START_AIR_COL]', 'port writes beginning airport');
has('cvObj[SUBITEM_END_AIR_COL]', 'port writes end airport');
has("filled===4?'both'", 'caret green requires all four fields');

/* v7.50 asserts: airport col ids, sandbox tag removal, remove extra photos */
has('v7.50:', 'v7.50 deploy marker present');
// (A) hardcoded airport col ids
has('text_mm5exz7q', 'beginning-airport column id present');
has('text_mm5f30a9', 'end-airport column id present');
lacks('function resolveAirportCols(', 'v7.49 title resolver removed');
// (B) sandbox tag removal
has('function sbRemoveFromTag(', 'sandbox tag-removal handler present');
has('sb-trash-btn', 'sandbox trash button rendered/styled');
has('create_labels_if_missing:false', 'tag removal writes remaining labels');
// (C) remove extra photos
has('function toggleRemovePhotos(', 'remove-photos toggle present');
has('function enqueueRemovePhotosJob(', 'remove-photos enqueue present');
has('async function runRemovePhotosPhase(', 'remove-photos worker present');
has("job.kind==='removephotos'", 'runPhotoJob branches on removephotos');
has('is-removing', 'remove selection styled');
has('removePhotoMode=false; pendingRemoveIds.clear()', 'remove mode resets on photo (re)load');

/* v7.51: trash button position fix */
has('v7.51:', 'v7.51 deploy marker present');
has('.sb-trash-btn{position:absolute;left:6px;top:103px', 'trash button on thumbnail (not overlapping name)');

/* v7.52 asserts: status dropdown, default-all boot, sandbox left sidebar */
has('v7.52:', 'v7.52 deploy marker present');
// (A) status dropdown
has('const STATUS_META=', 'status meta/colors present');
has('function syncStatusDropdown(', 'status dropdown sync present');
has('function pickStatus(', 'status option handler present');
has('class="status-dd"', 'status dropdown container present');
has('syncStatusDropdown(mode)', 'setMode syncs the status dropdown');
lacks('onclick="setMode(\'5a\')">5-APPROVED', 'per-status tab buttons removed from the bar');
// (B) default all on boot
has("else { setMode('all'); }", 'app boots into ALL MODELS');
// (C) sandbox left sidebar
has('class="sb-layout"', 'sandbox two-column layout present');
has('class="sb-side"', 'sandbox steps sidebar present');
has('.sb-side{flex:0 0 380px', 'sandbox sidebar sized');

/* v7.53 asserts: delete model, dropdown fix, mobile parity, recrop rotate, rechoose→queue */
has('v7.53:', 'v7.53 deploy marker present');
// (A) delete model
has('function deleteCurrentModel(', 'delete-model handler present');
has('id="delete-model-btn"', 'delete-model button present');
has('label:{index:6}', 'delete sets MODEL STATUS to DELETE (index 6)');
// (B) dropdown clipping fix
has('.nav-status-menu{position:fixed;z-index:9500', 'nav status menu is fixed-positioned under a unique class');
has('r.bottom+4', 'status menu positioned under its button on open');
/* v7.54: nav dropdown no longer collides with the editor status dropdown */
has('id="nav-status-menu"', 'nav dropdown menu uniquely named');
has("getElementById('nav-status-menu')", 'nav dropdown JS targets the unique menu');
// (C) mobile parity
has('<optgroup label="Status">', 'mobile select groups statuses');
has('<option value="sb">Casting Sandbox</option>', 'mobile has casting sandbox');
has('<option value="kanban">Kanban</option>', 'mobile has kanban');
// (D) recrop rotate
has('function rotateRecrop(', 'recrop rotate handler present');
has('id="recrop-rotate"', 'recrop rotate button present');
// (E) rechoose → queue
has('openRecrop(currentItem.id, assetId)', 'v7.56: picking a new headshot opens recrop to crop it first');

/* v7.55: collapse blank left nav column */
has('v7.55:', 'v7.55 deploy marker present');
has('.main.no-sidebar{grid-template-columns:1fr}', 'blank nav collapses the column');
has("classList.toggle('no-sidebar', type==='blank')", 'buildSidebarNav toggles the collapse');

/* v7.56: new-tag at top, delete at bottom, pick→crop */
has('v7.56:', 'v7.56 deploy marker present');
has('list.innerHTML = newRow + rows', 'new-tag row is at the top of the picker');
has('id="delete-model-row"', 'delete moved to a bottom danger zone');
has('.danger-zone{display:flex', 'danger zone styled');
has("_db.style.display=(currentMode==='3')?'none':'flex'", 'delete shows only in the full editor');

/* v7.57: recrop a freshly-uploaded local headshot */
has('v7.57:', 'v7.57 deploy marker present');
has('async function openRecropLocal(', 'local-file recrop entry present');
has('function maybeRecropLocalHeadshot(', 'auto-recrop gate present');
has("rcState.mode==='local'", 'saveRecrop handles local-file mode (callback, no job)');
has('maybeRecropLocalHeadshot(files[0]', 'dropped headshot triggers recrop');

/* v7.58 cleanup: dead code removed, perf, gqlRetry standardization */
has('v7.58:', 'v7.58 deploy marker present');
lacks('function applyHeadshotSwap(', 'dead applyHeadshotSwap removed');
lacks('let pendingHeadshotAssetId', 'dead pendingHeadshotAssetId removed');
lacks('function refreshHeadEverywhere(', 'dead refreshHeadEverywhere removed');
lacks('id="iv-upload-progress"', 'inert iv upload overlay removed');
lacks('id="fv-upload-progress"', 'inert fv upload overlay removed');
has('function modelById(', 'O(1) id->model index present');
has('kanbanItems=items; rebuildModelIndex()', 'index rebuilt on load');
has('content-visibility:auto;contain-intrinsic-size:0 300px', 'grid tiles skip off-screen render');
has('await setHeadMedThumb(itemId, job.croppedFile, bId)', 'recrop regenerates head med-thumb');
has('await gqlRetry(`mutation($i:ID!,$b:ID!,$c:JSON!){change_multiple_column_values', 'idempotent writes use gqlRetry');
lacks('await gql(`mutation($i:ID!,$b:ID!,$c:JSON!){change_multiple_column_values', 'no idempotent column writes left on plain gql');

/* v7.59: batch head-thumbnail backfill */
has('v7.59:', 'v7.59 deploy marker present');
has('function thumbBackfillCandidates(', 'backfill candidate scan present');
has('function startThumbBackfill(', 'backfill trigger present');
has('async function runRegenThumbPhase(', 'regen-thumb worker present');
has("job.kind==='regenthumb'", 'runPhotoJob branches on regenthumb');
has('id="thumb-backfill-btn"', 'backfill button present');
has("m.head && !m.medHead", 'candidates = headshot present but thumb missing');

/* v7.60: throttle + bound the thumbnail batch */
has('v7.60:', 'v7.60 deploy marker present');
has('BG_BATCH_THROTTLE_MS = 1200', 'batch throttle constant present');
has("if(job.kind==='regenthumb') setTimeout(()=>{ try{ pumpBgJobs(); }catch(e){} }, BG_BATCH_THROTTLE_MS)", 'batch jobs paced; interactive jobs pump immediately');
has('const CAP=250;', 'batch capped per click');
has('bgJobs = bgJobs.filter(j=>j!==job); renderBgJobs();', 'finished batch rows auto-cleared');

/* v7.67: Name QA tab (read-only audit) */
has('v7.67:', 'v7.67 deploy marker present');
has('id="nameqa-view"', 'name qa view present');
has("data-mode=\"nameqa\"", 'name qa nav tab present');
has("mode==='nameqa'", 'setMode handles nameqa');
has('function nqRunScan(', 'scan is a human-triggered function');
has('function nqScanValue(', 'scan engine present');
has('function nqUseSuggestion(', 'suggestions are click-to-apply into an editable field');
has('let CONTENT_TRACKER_BOARD_ID', 'CT board id is env-overridable via /config');
lacks('nqApply', 'v7.67 has NO write path (read-only phase)');
/* v7.66: budgets aligned to vendor default */
has('v7.66:', 'v7.66 deploy marker present');
has('capMs=fresh?290000:200000', 'client cap above server budget');
/* v7.65: realistic budgets */
has('v7.65:', 'v7.65 deploy marker present');
/* v7.64: wall-clock deadlines */
has('v7.64:', 'v7.64 deploy marker present');
/* v7.63: scrape progress + index-first */
has('v7.63:', 'v7.63 deploy marker present');
has('function startScrapeProgress(', 'scrape progress controller present');
has('scrape-prog-track', 'indeterminate progress bar present');
has('new AbortController()', 'scrape has a hard client-side timeout');
has("scrapePhotos(ctx, true)", 'force-refresh retry offered');
has("source==='twitter'?'From Twitter/X. '", 'scrape grid labels twitter source');
/* v7.62: ESM load fix */
has('v7.62:', 'v7.62 deploy marker present');
/* v7.61: Twitter/X scraping (client side) */
has('v7.61:', 'v7.61 deploy marker present');
has("['f-dup__of_facebook','f-lien_internet']", 'fv scrape falls back to Bluesky then Twitter/X');
has("['ive-dup__of_facebook','ive-lien_internet']", 'iv scrape falls back to Bluesky then Twitter/X');
has('Bluesky or Twitter/X link to the record first', 'empty-URL toast mentions both platforms');

console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
