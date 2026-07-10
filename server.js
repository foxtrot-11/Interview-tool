const express = require('express');
const compression = require('compression');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { parse, visit } = require('graphql');
const { rateLimit } = require('express-rate-limit');

const app = express();
// Render runs this app behind one proxy hop. Trust exactly that hop so the rate
// limiter sees each visitor's real IP (via X-Forwarded-For) instead of lumping
// everyone under the proxy's IP. Set to a number (not `true`) on purpose — `true`
// would trust a client-spoofable header.
app.set('trust proxy', 1);
// Photo uploads: cap size and accept images only. The client compresses before
// upload, so real photos are well under this; the cap just stops someone pushing
// a huge file (which could exhaust this small instance) or a non-image into monday.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_UPLOAD_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_UPLOAD_MIMES.has((file.mimetype || '').toLowerCase())) return cb(null, true);
    cb(new Error('UNSUPPORTED_TYPE'));
  },
});
// Runs multer for a single 'file' field and turns its errors into clean JSON
// (instead of Express's default HTML error page).
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 25 MB).' });
    if (err.message === 'UNSUPPORTED_TYPE') return res.status(415).json({ error: 'Only image files are allowed (jpg, png, webp, gif, heic).' });
    return res.status(400).json({ error: 'Upload rejected.' });
  });
}

// Token comes ONLY from Render env var MONDAY_TOKEN. No hardcoded fallback,
// so a misconfigured deploy fails loudly instead of silently using an old token.
const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
if (!MONDAY_TOKEN) {
  console.error('FATAL: MONDAY_TOKEN environment variable is not set.');
  process.exit(1);
}

// ── SHARED-PASSWORD GATE (server-enforced) ───────────────────────────────────
// The browser login screen only hid the UI; the data endpoints were open to
// anyone with the URL. This requires a shared password (stored server-side as an
// env var, never in the page) on every data request. A request without the
// correct password is refused before the monday token is ever attached.
// This is interim hardening — a stepping stone to per-user Google SSO, not a
// replacement for it. If APP_PASSWORD is unset the gate fails CLOSED (rejects
// everything) so a misconfigured deploy is loudly broken rather than silently open.
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) {
  console.warn('WARNING: APP_PASSWORD is not set — all data endpoints will reject requests until it is configured.');
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return res.status(401).json({ error: 'auth not configured' });
  const provided = req.get('X-App-Auth') || '';
  if (!safeEqual(provided, APP_PASSWORD)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ── RATE LIMITS ──────────────────────────────────────────────────────────────
// Two speed limits, per visitor IP. The data limiter is generous (normal use
// never hits it) but caps a flood/scrape. The auth limiter is strict and only
// counts FAILED password attempts, so it stops brute-forcing without ever
// throttling a legitimate user who has the right password. Counters live in
// memory (fine for this single free-tier instance) and reset on restart.
const dataLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute
  max: 500,                     // generous for humans; blocks floods
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again in a minute.' },
});
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,     // 10 minutes
  max: 15,                      // only failed attempts count (see below)
  skipSuccessfulRequests: true, // a correct password never counts against the limit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed login attempts — please wait a few minutes and try again.' },
});

// ── /api ALLOW-LIST GUARD ────────────────────────────────────────────────────
// The /api endpoint used to forward ANY GraphQL the browser sent, with the
// powerful token attached — a "blank check". This guard parses each request and
// only lets through the handful of operations this app actually performs, and
// only against the boards it actually uses. It PARSES the query (real AST) rather
// than string-matching, so reformatting/alias/comment tricks can't slip past.
// Board IDs come from env vars so staging can point at a test board without any
// code change. If unset (production), they fall back to the real production boards —
// so production behaves identically whether or not the vars are set.
const MAIN_BOARD_ID  = process.env.MAIN_BOARD_ID  || '3636652411';
const BATCH_BOARD_ID = process.env.BATCH_BOARD_ID || '18416230588';
// v7.14: the Port-to-Casting feature reads the CASTING PRIORITY STACK and links models
// into its subitem board. These two IDs are the same in every environment (there is no
// staging casting board), so they are allow-listed unconditionally. Note the MODEL NAME
// link column itself only accepts production-tracker items — Monday enforces that.
const CASTING_BOARD_ID = '8533133380';
const CASTING_SUBITEM_BOARD_ID = '8533133826';
// v7.21: Casting Sandbox "save states" board — one item per saved arrangement (JSON in a Long Text
// column). Same id in every environment (saves are app data, not per-environment), so unconditional.
// Only needs reads (boards/items) + create_item, both already in the root allow-lists.
const SANDBOX_SAVES_BOARD_ID = '18420711215';
const ALLOWED_BOARD_IDS = new Set([MAIN_BOARD_ID, BATCH_BOARD_ID, CASTING_BOARD_ID, CASTING_SUBITEM_BOARD_ID, SANDBOX_SAVES_BOARD_ID]); // whichever boards this environment uses + casting stack + sandbox saves
const ALLOWED_QUERY_ROOTS = new Set(['boards', 'items', 'assets']);
const ALLOWED_MUTATION_ROOTS = new Set([
  'change_multiple_column_values',
  'create_subitem',
  'change_simple_column_value',
  'create_item',
  'create_update',
  'delete_item',
]);

function validateGraphQL(query, variables) {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, reason: 'empty query' };
  let ast;
  try { ast = parse(query); } catch { return { ok: false, reason: 'unparseable query' }; }

  // Only plain query/mutation operations; no fragments, no batching/smuggling.
  if (ast.definitions.some(d => d.kind !== 'OperationDefinition'))
    return { ok: false, reason: 'only plain query/mutation operations are allowed' };
  const ops = ast.definitions.filter(d => d.kind === 'OperationDefinition');
  if (ops.length !== 1) return { ok: false, reason: 'exactly one operation per request' };

  const op = ops[0];
  if (op.operation === 'subscription') return { ok: false, reason: 'subscriptions not allowed' };
  const allowedRoots = op.operation === 'mutation' ? ALLOWED_MUTATION_ROOTS : ALLOWED_QUERY_ROOTS;

  for (const sel of op.selectionSet.selections) {
    if (sel.kind !== 'Field') return { ok: false, reason: 'unexpected selection' };
    if (!allowedRoots.has(sel.name.value))
      return { ok: false, reason: `operation not allowed: ${sel.name.value}` };
  }

  // Board scoping: any board_id argument, or boards(ids:[...]), must be allow-listed.
  // Variable values are resolved against the request's variables object.
  const vars = variables || {};
  const resolve = (node) => {
    if (!node) return undefined;
    if (node.kind === 'IntValue' || node.kind === 'StringValue' || node.kind === 'FloatValue') return String(node.value);
    if (node.kind === 'Variable') { const v = vars[node.name.value]; return v === undefined ? undefined : v; }
    if (node.kind === 'ListValue') return node.values.map(resolve);
    return undefined;
  };
  let violation = null;
  visit(ast, {
    Argument(node) {
      if (node.name.value === 'board_id') {
        const val = resolve(node.value);
        const arr = Array.isArray(val) ? val : [val];
        for (const v of arr) if (v !== undefined && !ALLOWED_BOARD_IDS.has(String(v))) violation = `board_id not allowed: ${v}`;
      }
    },
    Field(node) {
      if (node.name.value === 'boards') {
        const idsArg = (node.arguments || []).find(a => a.name.value === 'ids');
        if (idsArg) {
          const val = resolve(idsArg.value);
          const arr = Array.isArray(val) ? val : [val];
          for (const v of arr) if (v !== undefined && !ALLOWED_BOARD_IDS.has(String(v))) violation = `boards(ids) not allowed: ${v}`;
        }
      }
    },
  });
  if (violation) return { ok: false, reason: violation };
  return { ok: true };
}

// Tell search engines not to index this app, on EVERY response (strongest signal —
// works even for crawlers that don't parse the HTML meta tag).
app.use((_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});

// Explicit robots.txt disallowing all crawlers.
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// v7.32: gzip all compressible responses (index.html ~419KB→~108KB, and every /api JSON
// board page compresses ~5-8×). Must run BEFORE static + routes. Already-compressed image
// bytes (/asset-bytes, /proxy-image) are skipped automatically by content-type.
app.use(compression());

// v7.32: long-cache immutable static assets (logo, etc.) so browsers don't refetch them,
// but keep index.html on ETag revalidation so a deploy propagates immediately.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache'); // revalidate every load; deploys show up at once
    }
  },
}));
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// The client is a static file and can't read env vars directly, so it fetches its
// board IDs from here on startup. Production returns the real IDs; staging returns
// the test board. No secrets here — just board IDs.
app.get('/config', (_req, res) => {
  res.json({ mainBoardId: MAIN_BOARD_ID, batchBoardId: BATCH_BOARD_ID });
});

// Relay GraphQL queries/mutations to monday, attaching the token server-side.
// The browser never sees the token — it only ever calls this same-origin endpoint.
// Every request is first checked against the allow-list guard above.
// Lightweight endpoint the login screen calls to validate the password without
// touching monday. Returns 200 if the password header is correct, 401 otherwise.
app.get('/auth-check', authLimiter, requireAuth, (_req, res) => res.json({ ok: true }));

app.post('/api', dataLimiter, requireAuth, async (req, res) => {
  try {
    const { query, variables } = req.body || {};
    if (!query) return res.status(400).json({ error: 'missing query' });

    const verdict = validateGraphQL(query, variables);
    if (!verdict.ok) {
      console.warn('Blocked /api request:', verdict.reason);
      return res.status(403).json({ errors: [{ message: 'Request not permitted: ' + verdict.reason }] });
    }

    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: MONDAY_TOKEN,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const j = await r.json();
    res.status(r.ok ? 200 : r.status).json(j);
  } catch (e) {
    res.status(500).json({ errors: [{ message: e.message }] });
  }
});

// Relay a file upload to monday's /v2/file endpoint (which blocks browser CORS)
app.post('/upload', dataLimiter, requireAuth, uploadSingle, async (req, res) => {
  try {
    const { itemId, columnId } = req.body;
    if (!req.file || !itemId || !columnId) {
      return res.status(400).json({ error: 'missing file, itemId, or columnId' });
    }

    const query = `mutation add_file($file: File!) { add_file_to_column (item_id: ${parseInt(itemId, 10)}, column_id: "${columnId}", file: $file) { id } }`;

    const form = new FormData();
    form.append('query', query);
    form.append('variables[file]', new Blob([req.file.buffer], { type: req.file.mimetype }), safeFileName(req.file.originalname, req.file.mimetype, 'upload'));

    const r = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: { Authorization: MONDAY_TOKEN },
      body: form,
    });
    const j = await r.json();
    if (j.errors) return res.status(502).json({ error: j.errors[0].message });
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Foolproof "move/copy a photo between columns": downloads the real bytes of an
// existing asset server-side and re-uploads them via add_file_to_column to the
// target column — producing a genuine owned asset (never an assetId reference).
app.post('/move-asset', dataLimiter, requireAuth, async (req, res) => {
  try {
    const { itemId, targetColumnId, assetId } = req.body || {};
    if (!itemId || !targetColumnId || !assetId) {
      return res.status(400).json({ error: 'missing itemId, targetColumnId, or assetId' });
    }
    const newId = await copyAssetToColumn(itemId, targetColumnId, assetId);
    res.json({ ok: true, newAssetId: newId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Atomic photo rearrange: given the desired final arrangement (which existing
// assetIds should end up as the headshot vs. extras), this downloads ALL the bytes
// first (while originals still exist), then clears both columns, then re-uploads
// each as a fresh owned asset in the right column. Correct ordering guaranteed,
// so it can never orphan. Body: { itemId, boardId, headshotAssetIds:[], extraAssetIds:[] }
app.post('/rearrange-photos', dataLimiter, requireAuth, async (req, res) => {
  try {
    const { itemId, boardId, headshotAssetIds = [], extraAssetIds = [] } = req.body || {};
    if (!itemId || !boardId) return res.status(400).json({ error: 'missing itemId or boardId' });
    // Defense in depth: only operate on boards this app is allowed to touch.
    if (!ALLOWED_BOARD_IDS.has(String(boardId))) return res.status(403).json({ error: 'board not permitted' });

    const HEADSHOT_COL = 'files_mkncw5nm';
    const EXTRAS_COL = 'file_mkp1n4bt';

    // 1) Download all bytes FIRST (originals still exist at this point)
    const headBufs = [];
    for (const aid of headshotAssetIds) headBufs.push(await downloadAsset(aid));
    const extraBufs = [];
    for (const aid of extraAssetIds) extraBufs.push(await downloadAsset(aid));

    // 2) Clear both columns (removes originals)
    await mondayGql(
      `mutation($i:ID!,$b:ID!,$c:JSON!){change_multiple_column_values(item_id:$i,board_id:$b,column_values:$c){id}}`,
      { i: String(itemId), b: String(boardId), c: JSON.stringify({ [HEADSHOT_COL]: { clear_all: true }, [EXTRAS_COL]: { clear_all: true } }) }
    );
    // Let the clear settle before re-uploading (monday is eventually-consistent here;
    // uploading too soon after a clear can attach to a column still mid-clear).
    await new Promise(r => setTimeout(r, 1200));

    // 3) Re-upload fresh owned copies in order. uploadBufferToColumn throws on any
    // monday validation error, so a bad filename can no longer silently orphan.
    const newHead = [];
    for (const b of headBufs) {
      const id = await uploadBufferToColumn(itemId, HEADSHOT_COL, b);
      if (!id) throw new Error('headshot re-upload returned no asset id');
      newHead.push(id);
    }
    const newExtras = [];
    for (const b of extraBufs) {
      const id = await uploadBufferToColumn(itemId, EXTRAS_COL, b);
      if (!id) throw new Error('extra re-upload returned no asset id');
      newExtras.push(id);
    }

    res.json({ ok: true, headshotAssetIds: newHead, extraAssetIds: newExtras });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- shared helpers ----
// v7.12: same-origin asset bytes for the headshot recropper. monday's S3 public_url
// sends no CORS headers, so the browser cannot read pixels from it directly; this
// streams the same bytes from our own origin instead. Auth + rate-limited like /api.
app.get('/asset-bytes', dataLimiter, requireAuth, async (req, res) => {
  try {
    const assetId = String(req.query.assetId || '').replace(/[^0-9]/g, '');
    if (!assetId) return res.status(400).json({ error: 'assetId required' });
    const a = await downloadAsset(assetId);
    res.set('Content-Type', a.mime || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(a.buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── v7.28: PHOTO SCRAPE (Bluesky + generic page) ─────────────────────────────
// REST (not GraphQL, so outside the /api allow-list) but still behind requireAuth + dataLimiter.
// The real risk is SSRF — the server fetches a user-supplied URL — so EVERY outbound fetch goes through
// safeFetch(), which re-validates the host on each redirect hop: http/https only, and the resolved IP must
// be public (no loopback/private/link-local/CGNAT/cloud-metadata). Only staff with the app passphrase can
// reach these endpoints at all.
const dns = require('dns').promises;
function ipIsPrivate(ip){
  if(!ip) return true;
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); if(m) ip = m[1];
  if(ip.indexOf('.')>=0){                              // IPv4
    const p = ip.split('.').map(Number);
    if(p.length!==4 || p.some(n=>isNaN(n)||n<0||n>255)) return true;
    const [a,b,c] = p;
    if(a===0||a===10||a===127) return true;
    if(a===169&&b===254) return true;                  // link-local incl. 169.254.169.254 metadata
    if(a===172&&b>=16&&b<=31) return true;
    if(a===192&&b===168) return true;
    if(a===100&&b>=64&&b<=127) return true;            // CGNAT
    if(a===192&&b===0&&c===2) return true;             // TEST-NET-1
    if(a>=224) return true;                            // multicast / reserved
    return false;
  }
  const low = ip.toLowerCase();                        // IPv6
  if(low==='::1'||low==='::') return true;
  if(low.startsWith('fe80')||low.startsWith('fc')||low.startsWith('fd')) return true;
  return false;
}
async function assertPublicHttpUrl(raw){
  let u; try{ u = new URL(raw); }catch(e){ throw new Error('invalid URL'); }
  if(u.protocol!=='http:' && u.protocol!=='https:') throw new Error('only http/https allowed');
  if(/^(localhost|.*\.local)$/i.test(u.hostname)) throw new Error('blocked host');
  let addrs; try{ addrs = await dns.lookup(u.hostname,{all:true}); }catch(e){ throw new Error('DNS resolve failed'); }
  if(!addrs.length) throw new Error('no address');
  for(const a of addrs){ if(ipIsPrivate(a.address)) throw new Error('blocked (non-public address)'); }
  return u;
}
// fetch that re-validates the target on every redirect hop (so a public URL can't 302 into a private IP)
async function safeFetch(rawUrl, opts, maxHops){
  maxHops = (maxHops==null)?4:maxHops;
  let url = rawUrl;
  for(let i=0;i<=maxHops;i++){
    const u = await assertPublicHttpUrl(url);
    const r = await fetch(u.href, Object.assign({ redirect:'manual' }, opts||{}));
    if(r.status>=300 && r.status<400 && r.headers.get('location')){
      url = new URL(r.headers.get('location'), u.href).href; continue;
    }
    return r;
  }
  throw new Error('too many redirects');
}
// Bluesky actor out of a bsky.app URL or a bare handle; null if not Bluesky.
function parseBlueskyActor(input){
  const s = String(input||'').trim();
  try{
    const u = new URL(s);
    if(/(^|\.)bsky\.app$/i.test(u.hostname)){ const m = u.pathname.match(/\/profile\/([^/]+)/i); if(m) return decodeURIComponent(m[1]); }
    return null;
  }catch(e){
    if(/^@?[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) && !/\s/.test(s)) return s.replace(/^@/,'');
    return null;
  }
}
// Up to `cap` absolute image URLs from static HTML (og:image first, then <img> src/srcset), junk filtered.
function extractImageUrls(html, baseUrl, cap){
  cap = cap||10; const out=[]; const seen=new Set();
  const add = (raw)=>{ if(!raw||out.length>=cap) return; let abs; try{ abs=new URL(raw, baseUrl).href; }catch(e){ return; }
    if(!/^https?:/i.test(abs)) return;
    if(/\.svg(\?|$)/i.test(abs)) return;
    if(/(sprite|favicon|logo|icon|avatar-default|placeholder|blank|spacer|pixel|1x1|tracking)/i.test(abs)) return;
    if(seen.has(abs)) return; seen.add(abs); out.push(abs); };
  const metaRe=/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi; let mm;
  while((mm=metaRe.exec(html))){ const c=mm[0].match(/content=["']([^"']+)["']/i); if(c) add(c[1]); }
  const imgRe=/<img\b[^>]*>/gi; let im;
  while((im=imgRe.exec(html)) && out.length<cap){ const tag=im[0];
    const ss=tag.match(/srcset=["']([^"']+)["']/i);
    if(ss){ const cands=ss[1].split(',').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean); if(cands.length) add(cands[cands.length-1]); }
    const src=tag.match(/\bsrc=["']([^"']+)["']/i); if(src) add(src[1]); }
  return out.slice(0,cap);
}

app.get('/scrape-images', dataLimiter, requireAuth, async (req, res) => {
  try{
    const input = String(req.query.url||'').trim();
    if(!input) return res.status(400).json({ error:'url required' });
    const actor = parseBlueskyActor(input);
    if(actor){
      const api = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor='+encodeURIComponent(actor)+'&limit=40&filter=posts_with_media';
      const r = await safeFetch(api, { headers:{ 'Accept':'application/json' } });
      if(!r.ok) return res.status(502).json({ error:'Bluesky fetch failed ('+r.status+') — check the handle' });
      const j = await r.json();
      const imgs=[]; const seen=new Set();
      for(const it of (j.feed||[])){
        const e = it.post && it.post.embed; if(!e){ continue; }
        const arr = e.images || (e.media && e.media.images) || [];
        for(const p of arr){ const u = p.fullsize || p.thumb; if(u && !seen.has(u)){ seen.add(u); imgs.push({ url:u, thumb:p.thumb||u }); } }
        if(imgs.length>=10) break;
      }
      return res.json({ source:'bluesky', actor, images: imgs.slice(0,10) });
    }
    const u = await assertPublicHttpUrl(input);
    const r = await safeFetch(u.href, { headers:{ 'User-Agent':'Mozilla/5.0 (compatible; CarnalTool/1.0)', 'Accept':'text/html' } });
    if(!r.ok) return res.status(502).json({ error:'page fetch failed ('+r.status+')' });
    if(!/text\/html|application\/xhtml/i.test(r.headers.get('content-type')||'')) return res.status(415).json({ error:'not an HTML page' });
    const html = (await r.text()).slice(0, 2000000);
    return res.json({ source:'page', images: extractImageUrls(html, u.href, 10).map(x=>({ url:x, thumb:x })) });
  }catch(e){ res.status(400).json({ error: e.message||String(e) }); }
});

app.get('/proxy-image', dataLimiter, requireAuth, async (req, res) => {
  try{
    const r = await safeFetch(String(req.query.url||''), { headers:{ 'User-Agent':'Mozilla/5.0 (compatible; CarnalTool/1.0)' } });
    if(!r.ok) return res.status(502).json({ error:'fetch failed ('+r.status+')' });
    const ct = r.headers.get('content-type')||'application/octet-stream';
    if(!/^image\//i.test(ct)) return res.status(415).json({ error:'not an image' });
    const buf = Buffer.from(await r.arrayBuffer());
    if(buf.length > 15000000) return res.status(413).json({ error:'image too large' });
    res.set('Content-Type', ct); res.set('Cache-Control','private, max-age=300'); res.send(buf);
  }catch(e){ res.status(400).json({ error: e.message||String(e) }); }
});

async function mondayGql(query, variables) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: MONDAY_TOKEN, 'API-Version': '2024-01' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
async function downloadAsset(assetId) {
  const d = await mondayGql(`query($ids:[ID!]!){assets(ids:$ids){id name public_url}}`, { ids: [String(assetId)] });
  const asset = d?.assets?.[0];
  if (!asset || !asset.public_url) throw new Error('asset ' + assetId + ' not found / no url');
  const fr = await fetch(asset.public_url);
  if (!fr.ok) throw new Error('failed to download asset ' + assetId);
  const buf = Buffer.from(await fr.arrayBuffer());
  const mime = fr.headers.get('content-type') || 'application/octet-stream';
  return { buf, name: safeFileName(asset.name, mime, assetId), mime };
}

// monday rejects uploads whose filename has odd characters (e.g. the non-breaking
// space monday itself puts in screenshot names) or an unsupported/missing extension.
// Sanitize: strip non-ASCII + risky chars, and force a known-good image extension
// derived from the content-type so the upload always validates.
function safeFileName(rawName, mime, assetId) {
  const extByMime = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'jpg', 'image/heif': 'jpg',
  };
  let ext = extByMime[(mime || '').toLowerCase().split(';')[0]] || '';
  // Try to recover an extension from the original name if mime didn't give one
  if (!ext && rawName) {
    const m = String(rawName).toLowerCase().match(/\.(jpe?g|png|webp|gif)$/);
    if (m) ext = m[1].replace('jpeg', 'jpg');
  }
  if (!ext) ext = 'jpg'; // safe default — these columns only hold images
  // Build a clean base: ASCII letters/digits/dot/dash/underscore only
  let base = String(rawName || ('photo_' + assetId))
    .replace(/\.(jpe?g|png|webp|gif)$/i, '')      // drop existing ext
    .replace(/[^\x20-\x7E]/g, '')                  // strip non-ASCII (incl. \u202f)
    .replace(/[^A-Za-z0-9._-]/g, '_')              // risky chars -> underscore
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!base) base = 'photo_' + assetId;
  return `${base}.${ext}`;
}
async function uploadBufferToColumn(itemId, columnId, fileObj) {
  const query = `mutation add_file($file: File!) { add_file_to_column (item_id: ${parseInt(itemId, 10)}, column_id: "${columnId}", file: $file) { id } }`;
  const form = new FormData();
  form.append('query', query);
  form.append('variables[file]', new Blob([fileObj.buf], { type: fileObj.mime }), fileObj.name);
  const r = await fetch('https://api.monday.com/v2/file', { method: 'POST', headers: { Authorization: MONDAY_TOKEN }, body: form });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j?.data?.add_file_to_column?.id;
}
async function copyAssetToColumn(itemId, columnId, assetId) {
  const f = await downloadAsset(assetId);
  return uploadBufferToColumn(itemId, columnId, f);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('interview-tool listening on', PORT));
