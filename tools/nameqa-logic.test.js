// Name QA engine tests — run against REAL strings sampled from Content Tracker (board 1818869745)
// on 2026-07-27, so the matcher is validated against the actual mess rather than tidy fixtures.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');

function grab(names) {
  const start = src.indexOf('const NQ_CT_CHAR_COLS');
  const end = src.indexOf('\nasync function scrapePhotos(ctx, fresh){');
  if (start < 0 || end < 0) throw new Error('Name QA engine block not found');
  const body = src.slice(start, end);
  return new Function(body + '\nreturn {' + names.join(',') + '};')();
}
const { nqNormalize, nqSplitSegments, nqSegmentParts, nqIsIgnorable, nqIsMalformed,
        nqSimilarity, nqSuggest, nqCategorize, nqScanValue, nqApplyPick, nqCanSend } =
  grab(['nqNormalize','nqSplitSegments','nqSegmentParts','nqIsIgnorable','nqIsMalformed',
        'nqSimilarity','nqSuggest','nqCategorize','nqScanValue','nqApplyPick','nqCanSend']);

let n = 0, fails = 0;
function eq(actual, expected, label) {
  n++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) console.log('  \u2713 ' + label);
  else { fails++; console.log('  \u2717 ' + label + '\n      expected ' + b + '\n      got      ' + a); }
}

// A small stand-in Model DB index built the same way the client builds it.
const CANON = ['Adam Snow','Adam Ryan','Adrian Rose','Sean Xavier','Cyrus Stark','Jake Matthews',
  'Killian Knox','Marcus McNeill','Jay Stryker','Lucky Cruz','Vincent O\'Reilly','Aidan Fox',
  'Alexandro Cabrera','Jaxx Cody','Logan Cross','Grayson Cole'];
const index = { byNorm: new Map(), entries: [] };
for (const c of CANON) {
  const e = { canonical: c, alias: c, norm: nqNormalize(c) };
  index.byNorm.set(e.norm, e);
  index.entries.push(e);
}
// one legitimate per-site alias, to prove aliases count as correct
{ const e = { canonical: 'Adam Snow', alias: 'A. Snow', norm: nqNormalize('A. Snow') };
  index.byNorm.set(e.norm, e); index.entries.push(e); }

console.log('[1] normalization + ignorables');
eq(nqNormalize('  Adam   SNOW '), 'adam snow', 'collapses whitespace + lowercases');
eq(nqIsIgnorable('LEAVE BLANK'), true, 'LEAVE BLANK sentinel ignored (real CT value)');
eq(nqIsIgnorable('n/a'), true, 'n/a ignored');
eq(nqIsIgnorable('-'), true, 'dash ignored');
eq(nqIsIgnorable('Adam Snow'), false, 'a real name is not ignorable');

console.log('[2] segment splitting keeps delimiters');
eq(nqSplitSegments('Adam Snow, Adam Ryan').map(s => s.text.trim()), ['Adam Snow','Adam Ryan'], 'comma split');
eq(nqSplitSegments('Adam Snow & Adam Ryan').map(s => s.delim), [' & ',''], 'delimiter preserved verbatim');
eq(nqSplitSegments('Adam Snow').length, 1, 'single name = one segment');

console.log('[3] paren handling — no guessing which side is the model');
eq(nqSegmentParts('Father Snow (Adam Snow)').includes('Adam Snow'), true, 'inner name is a candidate');
eq(nqSegmentParts('Father Snow (Adam Snow)').includes('Father Snow'), true, 'outer text is a candidate');
eq(nqSegmentParts('Sean Xavier [alumni]').includes('Sean Xavier'), true, '[alumni] stripped for matching');

console.log('[4] real CT rows that must NOT be flagged');
eq(nqScanValue('Father Snow (Adam Snow)', index).flagged, 0, 'role + real name in parens is clean');
eq(nqScanValue('Apprentice McNeill (Marcus McNeill)', index).flagged, 0, 'msb pattern clean');
eq(nqScanValue('Coach Knox (Killian Knox)', index).flagged, 0, 'ttp pattern clean');
eq(nqScanValue('LEAVE BLANK', index).flagged, 0, 'sentinel not flagged');
eq(nqScanValue('A. Snow', index).flagged, 0, 'legitimate site alias not flagged');
eq(nqScanValue('Sean Xavier [alumni]', index).flagged, 0, 'annotation not flagged');

console.log('[5] real CT typos that MUST be flagged, with a usable suggestion');
{ const r = nqScanValue('Sean Xaiver', index);
  eq(r.flagged, 1, 'Sean Xaiver flagged');
  const f = r.segments.find(s => s.status === 'flag');
  eq(f.category, 'likely_typo', 'categorised as likely typo');
  eq(f.suggestions[0].name, 'Sean Xavier', 'suggests Sean Xavier'); }
{ const f = nqScanValue('Cyurs Stark', index).segments.find(s => s.status === 'flag');
  eq(f.suggestions[0].name, 'Cyrus Stark', 'Cyurs Stark -> Cyrus Stark'); }
{ const f = nqScanValue('Jake Mathews', index).segments.find(s => s.status === 'flag');
  eq(f.suggestions[0].name, 'Jake Matthews', 'Jake Mathews -> Jake Matthews'); }

console.log('[6] case/formatting differences are separated from typos');
eq(nqScanValue('jaxx cody', index).caseOnly, 1, 'lowercase name = format, not typo');
eq(nqScanValue('jaxx cody', index).flagged, 0, 'format issues are not flagged as errors');
eq(nqScanValue('LOGAN CROSS', index).caseOnly, 1, 'ALL CAPS = format');

console.log('[7] the messy real-world cases are surfaced, not silently mangled');
{ // stray comma inside a real name — we do NOT rejoin; both halves surface for a human
  const r = nqScanValue("Grayson Cole, Vincent, O'Reilly, Adam Snow", index);
  eq(r.flagged, 2, 'stray comma surfaces two unmatched tokens (no auto-rejoin)');
  eq(r.segments.filter(s => s.status === 'ok').length, 2, 'the two valid names still pass'); }
eq(nqScanValue('Master Stryker (Master Stryker (Jay Stryker), Patriarch Smith', index)
    .segments.some(s => s.category === 'malformed'), true, 'unbalanced parens -> malformed');
{ const f = nqScanValue('Bastian Karim (new)', index).segments.find(s => s.status === 'flag');
  eq(f.category, 'marked_new', '(new) marker gets its own category'); }
{ const f = nqScanValue('Zeb Thunderfist', index).segments.find(s => s.status === 'flag');
  eq(f.category, 'unknown', 'no plausible match -> unknown');
  eq(f.suggestions.length, 0, 'and offers no guess'); }

console.log('[8] confidence bands behave (validated numbers from the handoff doc)');
eq(nqSimilarity('Brian Fitzgibbions','Brian Fitzgibbons') > 0.90, true, 'known typo pair scores High');
eq(nqSimilarity('Jay Wolfgang','Jay Wolf') < 0.75, true, 'two different real people stay below the floor');
eq(nqCategorize('x', { score: 0.95 }), 'likely_typo', '>=0.90 -> likely typo');
eq(nqCategorize('x', { score: 0.80 }), 'ambiguous', '0.75-0.90 -> ambiguous');
eq(nqCategorize('x', null), 'unknown', 'no candidate -> unknown');

console.log('[9] v7.68: same-name, different-profile candidates surface separately (the "Alex Smith" case)');
{ // Two different models can legitimately share an exact spelling. nqSuggest must keep both
  // as distinct candidates (deduped by id, not by name) so a human can tell them apart by
  // thumbnail before sending — collapsing to one silently picks a profile for them.
  const dupIndex = { byNorm: new Map(), entries: [] };
  const pushEntry = (id, canonical, headAsset) => {
    const e = { id, canonical, alias: canonical, norm: nqNormalize(canonical), headAsset };
    if (!dupIndex.byNorm.has(e.norm)) dupIndex.byNorm.set(e.norm, e);
    dupIndex.entries.push(e);
  };
  pushEntry('1001', 'Alex Smith', 'asset-a');
  pushEntry('2002', 'Alex Smith', 'asset-b'); // same spelling, different profile
  const out = nqSuggest('Alex Smyth', dupIndex.entries, 3);
  eq(out.length, 2, 'both Alex Smith profiles surface, not collapsed into one');
  eq(new Set(out.map(o => o.id)).size, 2, 'each candidate keeps its own profile id');
  eq(out.every(o => o.name === 'Alex Smith'), true, 'both still read as the correct known name');
  eq(out.map(o => o.headAsset).sort(), ['asset-a', 'asset-b'], 'each candidate carries its own headshot asset for the thumbnail check');
}
{ // Back-compat: fixtures without ids (like the CANON index above) still dedup by name, same
  // as before this change — a single index entry per name shouldn't produce duplicate chips.
  const noIdOut = nqSuggest('Sean Xaiver', index.entries, 3);
  eq(noIdOut.length, 1, 'no-id fixture index still dedups to one candidate per name');
}

/* ── v7.74 (1): GIVEN-NAME GATE ────────────────────────────────────────────────────────────────
   Whole-string edit distance overstates similarity when two people share a surname. Reported from
   live data: "Zander Woods" vs "Lance Woods" scored 75% — the same band as a genuine typo — purely
   on " Woods", while the real typo "Zander Woodz" scored 92%. The two were barely distinguishable.
   The gate must fire ONLY on a different given name; real typos land in given names too. */
console.log('[10] v7.74: given-name gate');
{
  const pct = (a,b) => Math.round(nqSimilarity(a,b)*100);
  // penalised — different person who happens to share a surname
  eq(pct('Zander Woods','Lance Woods') < 50, true, 'shared surname + different given name scores LOW (was 75%)');
  eq(pct('Zander Woods','Lance Woods') < pct('Zander Woods','Zander Woodz'), true,
     'the real typo now outranks the different-person match by a wide margin');
  // NOT penalised — these are the typos the tool exists to catch
  eq(pct('Zander Woods','Zander Woodz'), 92, 'surname typo unchanged at 92%');
  eq(pct('Sean Xaiver','Sean Xavier'), 91, 'Sean Xaiver unchanged at 91%');
  eq(pct('Cyurs Stark','Cyrus Stark'), 91, 'GIVEN-NAME transposition still 91% — the gate must not catch this');
  eq(pct('Jace Jaxon','Jace Jaxson'), 91, 'Jace Jaxon unchanged at 91%');
  eq(nqSimilarity('Adam Snow','Adam Snow'), 1, 'identical still 1');
  // single-token names are never gated (no given/surname structure to reason about)
  eq(nqSimilarity('Leandro','Leandra') > 0.8, true, 'single-token names are not gated');
  // the gate drops it below the 0.75 suggestion floor, so it stops being offered at all
  eq(nqSuggest('Zander Woods', [{norm:'lance woods', canonical:'Lance Woods', alias:'Lance Woods', id:'L1'}], 3).length, 0,
     'a different-person surname match is no longer offered as a candidate');
}

/* ── v7.74 (2): COMPOSITE SUBSTITUTION ─────────────────────────────────────────────────────────
   A Content Tracker value is often "CharacterName (PerformerName)". nqSegmentParts returns
   [whole, before-parens, inside-parens] and the probe is the LAST one, so the match is made against
   the parenthetical. Before v7.74 nqUseSuggestion replaced the WHOLE segment, collapsing
   "Boy Jace (Jace Jaxon)" to "Jace Jaxson" and destroying the character name. It must replace only
   the probe. This asserts the scan records the probe AND that substituting it rebuilds correctly. */
console.log('[11] v7.74: composite name substitution');
{
  // the probe the scan will carry through to nqUseSuggestion
  const probeOf = seg => { const p = nqSegmentParts(seg); return p[p.length-1]; };
  eq(probeOf('Boy Jace (Jace Jaxon)'), 'Jace Jaxon', 'probe is the parenthetical, not the whole segment');
  eq(probeOf('Sean Xaiver'), 'Sean Xaiver', 'probe falls back to the whole token when there are no parens');
  // the substitution nqUseSuggestion performs
  const sub = (cur, probe, name) => cur.split(probe).join(name);
  eq(sub('Boy Jace (Jace Jaxon)', probeOf('Boy Jace (Jace Jaxon)'), 'Jace Jaxson'),
     'Boy Jace (Jace Jaxson)', 'composite keeps the character name — the reported bug');
  eq(sub('Sean Xaiver', probeOf('Sean Xaiver'), 'Sean Xavier'),
     'Sean Xavier', 'plain name still replaced wholesale');
  eq(sub('Father Snow (Adam Snow)', probeOf('Father Snow (Adam Snow)'), 'Adam Snow'),
     'Father Snow (Adam Snow)', 'an already-correct composite is left intact');
  // the scan must actually record `probe` on the flagged row, or the fix cannot reach the UI
  const scan = nqScanValue('Boy Jace (Jace Jaxon)', index);
  const flag = scan.segments.find(s => s.status === 'flag');
  eq(!!flag, true, 'the composite is flagged');
  eq(flag && flag.probe, 'Jace Jaxon', 'the flagged row carries the probe through to the UI');
}

/* ── v7.74.1: PREVIEW PRE-FILL ──────────────────────────────────────────────────────────────────
   The box used to echo `was:` until a candidate was clicked, so the proposed composite was never
   visible up front. It is now pre-filled with the top suggestion applied — as a PREVIEW ONLY:
   resolutionType stays null so Send to Monday remains disabled until a profile is explicitly
   clicked, and nothing can be written from un-clicked text.
   The important regression guard here is nqApplyPick resolving from the ORIGINAL rather than the
   box: once the box is pre-filled it no longer contains the probe, so a box-based substitution made
   clicking a SECOND candidate silently do nothing. */
console.log('[12] v7.74.1: preview pre-fill resolves from the original');
{
  const original = 'Boy Jace (Jace Jaxon)';
  const parts = nqSegmentParts(original);
  const probe = parts[parts.length - 1];
  const token = original;
  // nqApplyPick is the shared helper both the pre-fill and the chip click use
  eq(nqApplyPick(original, token, probe, 'Jace Jaxson'), 'Boy Jace (Jace Jaxson)',
     'top suggestion pre-fills the composite');
  // clicking the SECOND candidate must still work off the original, not the pre-filled box
  eq(nqApplyPick(original, token, probe, 'Ace Jaxon'), 'Boy Jace (Ace Jaxon)',
     'a second candidate applies from the ORIGINAL, not the pre-filled box');
  // switching back and forth must not compound
  eq(nqApplyPick(original, token, probe, 'Jace Jaxson'), 'Boy Jace (Jace Jaxson)',
     'switching candidates never compounds edits');
  // plain (no parens) still replaced wholesale
  const p2 = nqSegmentParts('Sean Xaiver');
  eq(nqApplyPick('Sean Xaiver', 'Sean Xaiver', p2[p2.length-1], 'Sean Xavier'), 'Sean Xavier',
     'plain name still replaced wholesale');
  // a value with no probe match falls back to the whole token rather than doing nothing
  eq(nqApplyPick('Boy Jace (Jace Jaxon)', 'Boy Jace (Jace Jaxon)', 'NOT PRESENT', 'X'), 'X',
     'unmatched probe falls back to the whole token instead of silently no-oping');
  // nqCanSend must refuse a previewed-but-unclicked row
  const previewed = { corrected:'Boy Jace (Jace Jaxson)', original, preview:true,
                      resolutionType:null, chosenId:null, manualOn:false, sent:false };
  eq(nqCanSend(previewed), false, 'a PREVIEWED row cannot be sent — no profile chosen yet');
  eq(nqCanSend({ ...previewed, preview:false, resolutionType:'matched', chosenId:'P0' }), true,
     'once a profile is clicked it can be sent');
  eq(nqCanSend({ ...previewed, resolutionType:'matched', chosenId:null }), false,
     'matched without a profile id still cannot be sent');
  // hand-typed text alone is not sendable unless the manual box is on
  eq(nqCanSend({ ...previewed, preview:false, corrected:'Hand Typed' }), false,
     'hand-typed text alone cannot be sent');
}

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails ? 1 : 0);
