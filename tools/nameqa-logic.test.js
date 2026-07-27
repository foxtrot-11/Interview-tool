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
        nqSimilarity, nqSuggest, nqCategorize, nqScanValue } =
  grab(['nqNormalize','nqSplitSegments','nqSegmentParts','nqIsIgnorable','nqIsMalformed',
        'nqSimilarity','nqSuggest','nqCategorize','nqScanValue']);

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

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails ? 1 : 0);
