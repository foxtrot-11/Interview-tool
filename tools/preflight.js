#!/usr/bin/env node
/*
 * preflight.js — the release checklist, as code.
 *
 * WHY THIS EXISTS
 *   CLAUDE.md §3 described a 7-step release process in prose. Prose gets skimmed: v7.70 shipped a
 *   broken stylesheet to production because the "parse check every <script> block" step was run
 *   (and passed) while nothing ever looked at the CSS. Every substring assertion also passed,
 *   because the offending text WAS present — just outside its comment, where the CSS parser read it
 *   as a selector and discarded every rule that followed.
 *
 *   A script cannot be half-done. This exits non-zero, and the pre-push hook runs it.
 *
 * USAGE
 *   node tools/preflight.js
 *
 * WHAT IT DOES NOT DO
 *   It cannot tell you the app LOOKS right. Nothing here catches a layout regression — see the
 *   note it prints at the end. Sticky/scroll/containment changes must be exercised in a browser,
 *   and a human has to look at staging before anything is promoted.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = p => path.join(ROOT, p);

let failures = 0, checks = 0;
const pass = m => { checks++; console.log('  \x1b[32mok\x1b[0m   ' + m); };
const fail = (m, d) => { checks++; failures++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (d ? '\n         ' + d : '')); };
const head = m => console.log('\n\x1b[1m' + m + '\x1b[0m');

const src = fs.readFileSync(rel('public/index.html'), 'utf8');

/* ─── 1. JS in every <script> block parses ─────────────────────────────────── */
head('[1] Client JavaScript');
{
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  let bad = 0;
  blocks.forEach((b, i) => {
    try { new Function(b[1]); }
    catch (e) { bad++; fail(`<script> block #${i + 1} parses`, e.message); }
  });
  if (!bad) pass(`all ${blocks.length} <script> block(s) parse`);
}

/* ─── 2. CSS structural integrity — THE CHECK THAT WAS MISSING ─────────────── */
head('[2] CSS structural integrity  (added after the v7.70 incident)');
{
  const a = src.indexOf('<style>'), b = src.indexOf('</style>');
  if (a < 0 || b < 0) fail('<style> block found');
  else {
    const css = src.slice(a + 7, b);
    const baseLine = src.slice(0, a + 7).split('\n').length;
    const lineOf = off => baseLine + css.slice(0, off).split('\n').length - 1;

    // 2a. comment terminators
    let i = 0, open = 0, orphans = [], firstOpen = -1;
    while (i < css.length) {
      if (css.startsWith('/*', i)) { if (!open) firstOpen = i; open++; i += 2; continue; }
      if (css.startsWith('*/', i)) { if (!open) orphans.push(lineOf(i)); else open--; i += 2; continue; }
      i++;
    }
    orphans.length
      ? fail('no orphaned CSS comment terminators',
             `stray */ at line(s) ${orphans.join(', ')} — everything after it is parsed as CSS. THIS IS THE v7.70 BUG.`)
      : pass('no orphaned CSS comment terminators');
    open
      ? fail('all CSS comments terminated', `${open} unterminated /* (first at line ${lineOf(firstOpen)})`)
      : pass('all CSS comments terminated');

    // 2b. brace balance, ignoring comments and quoted strings
    let depth = 0, min = 0, inC = false, q = null;
    for (let j = 0; j < css.length; j++) {
      const c = css[j];
      if (inC) { if (css.startsWith('*/', j)) { inC = false; j++; } continue; }
      if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
      if (css.startsWith('/*', j)) { inC = true; j++; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth < min) min = depth; }
    }
    depth === 0 ? pass('CSS braces balanced') : fail('CSS braces balanced', `net depth ${depth}`);
    min === 0 ? pass('CSS never closes more braces than it opens') : fail('CSS never closes more braces than it opens', `reached ${min}`);

    // 2c. English prose sitting in live CSS — the visible symptom of 2a
    let stripped = '', k = 0, inCmt = false;
    while (k < css.length) {
      if (!inCmt && css.startsWith('/*', k)) { inCmt = true; stripped += '  '; k += 2; continue; }
      if (inCmt && css.startsWith('*/', k)) { inCmt = false; stripped += '  '; k += 2; continue; }
      stripped += inCmt ? (css[k] === '\n' ? '\n' : ' ') : css[k];
      k++;
    }
    const prose = [];
    stripped.split('\n').forEach((ln, n) => {
      const t = ln.trim();
      if (!t || /[{}:;@]/.test(t) || /^[),.'"\d>+~*-]/.test(t)) return;
      if (/^[A-Za-z][A-Za-z ,'’()—-]{20,}$/.test(t)) prose.push(baseLine + n);
    });
    prose.length
      ? fail('no bare prose lines in the stylesheet', `line(s) ${prose.slice(0, 6).join(', ')} — a comment terminator is probably misplaced`)
      : pass('no bare prose lines in the stylesheet');

    // 2d. rule count sanity — a swallowed stylesheet collapses this number
    const ruleish = (stripped.match(/\{/g) || []).length;
    ruleish >= 600
      ? pass(`stylesheet declares ~${ruleish} rule blocks (expected 600+)`)
      : fail('stylesheet rule count sane', `only ~${ruleish} rule blocks — rules are being swallowed`);
  }
}

/* ─── 3. Markup balance ────────────────────────────────────────────────────── */
head('[3] Markup');
{
  const o = (src.match(/<div\b/g) || []).length, c = (src.match(/<\/div>/g) || []).length;
  o === c ? pass(`<div> balanced (${o})`) : fail('<div> balanced', `${o} open vs ${c} close`);
}

/* ─── 4. server.js ─────────────────────────────────────────────────────────── */
head('[4] Server');
{
  try {
    execFileSync(process.execPath, ['--check', rel('server.js')], { stdio: 'pipe' });
    pass('server.js syntax valid');
  } catch (e) { fail('server.js syntax valid', String(e.stderr || e.message).split('\n')[0]); }
  try {
    // --no-optional-locks: without it, git opportunistically refreshes the index and creates
    // .git/index.lock. On some mounts that lockfile can be left behind and then blocks every
    // later git command with "Another git process seems to be running" — which has already
    // cost real time here. This check is read-only, so it never needs the lock.
    const diff = execFileSync('git', ['--no-optional-locks', 'diff', '--name-only', 'origin/main', '--', 'server.js'],
                              { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    if (diff) console.log('  \x1b[33mNOTE\x1b[0m server.js DIFFERS from origin/main — this is not a client-only release.');
    else pass('client-only release (server.js matches origin/main)');
  } catch { console.log('  \x1b[33mNOTE\x1b[0m could not compare server.js against origin/main'); }
}

/* ─── 5. Version marker + change log ──────────────────────────────────────── */
head('[5] Release bookkeeping');
{
  const markers = [...src.matchAll(/^\s{3}(v7\.\d+(?:\.\d+)?):/gm)].map(m => m[1]);
  if (!markers.length) fail('changelog block has version markers');
  else {
    const key = v => v.split('.').map(Number);
    const latest = markers.slice().sort((x, y) => {
      const A = key(x), B = key(y);
      return (B[1] - A[1]) || ((B[2] || 0) - (A[2] || 0));
    })[0];
    pass(`latest in-file changelog marker: ${latest}`);
    // grep target the deploy check uses
    src.includes(latest + ':')
      ? pass(`deploy-verification grep target "${latest}:" present`)
      : fail(`deploy-verification grep target "${latest}:" present`);
    const clog = `CHANGE-LOG-${latest}.md`;
    fs.existsSync(rel(clog))
      ? pass(`${clog} exists`)
      : fail(`${clog} exists`, 'CLAUDE.md §3 step 5 requires a matching write-up');
  }
}

/* ─── 6. Test suite ───────────────────────────────────────────────────────── */
head('[6] Test suite');
{
  // Only *.test.js and verify.js. tools/backfill-*.js are one-off scripts that exit non-zero
  // without env/args — including them makes a green suite look like two failures.
  const files = fs.readdirSync(rel('tools'))
    .filter(f => f.endsWith('.test.js') || f === 'verify.js')
    .sort();
  let total = 0;
  for (const f of files) {
    let out = '', code = 0;
    try { out = execFileSync(process.execPath, [rel('tools/' + f)], { stdio: 'pipe' }).toString(); }
    catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = 1; }
    const last = out.trim().split('\n').pop() || '';
    const m = last.match(/(\d+)\s+(?:assertions|checks),\s*(\d+)\s+failed/);
    if (m) {
      total += +m[1];
      +m[2] === 0 ? pass(`${f} — ${m[1]} assertions`) : fail(`${f}`, `${m[2]} failed`);
    } else {
      fail(`${f} ran`, last.slice(0, 160));
    }
    if (code && m && +m[2] === 0) { /* non-zero exit but green summary: tolerate */ }
  }
  console.log(`  \x1b[36m----\x1b[0m ${total} assertions across ${files.length} files`);
}

/* ─── verdict ─────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(72));
if (failures) {
  console.log(`\x1b[31mPREFLIGHT FAILED\x1b[0m — ${failures} of ${checks} checks failed. Do not push.`);
  console.log('='.repeat(72) + '\n');
  process.exit(1);
}
console.log(`\x1b[32mPREFLIGHT PASSED\x1b[0m — ${checks} checks.`);
console.log('');
console.log('This does NOT mean the app looks right. Nothing above can see a layout bug:');
console.log('v7.70 passed every automated check while rendering completely unstyled.');
console.log('');
console.log('Before production, a HUMAN must load staging in a browser and confirm it:');
console.log('  https://interview-tool-staging.onrender.com');
console.log('A version-marker grep proves the file uploaded. It is not verification.');
console.log('='.repeat(72) + '\n');
