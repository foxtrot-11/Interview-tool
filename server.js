const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// Token comes ONLY from Render env var MONDAY_TOKEN. No hardcoded fallback,
// so a misconfigured deploy fails loudly instead of silently using an old token.
const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
if (!MONDAY_TOKEN) {
  console.error('FATAL: MONDAY_TOKEN environment variable is not set.');
  process.exit(1);
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Relay GraphQL queries/mutations to monday, attaching the token server-side.
// The browser never sees the token — it only ever calls this same-origin endpoint.
app.post('/api', async (req, res) => {
  try {
    const { query, variables } = req.body || {};
    if (!query) return res.status(400).json({ error: 'missing query' });

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
app.post('/upload', upload.single('file'), async (req, res) => {
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
app.post('/move-asset', async (req, res) => {
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
app.post('/rearrange-photos', async (req, res) => {
  try {
    const { itemId, boardId, headshotAssetIds = [], extraAssetIds = [] } = req.body || {};
    if (!itemId || !boardId) return res.status(400).json({ error: 'missing itemId or boardId' });

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
  const d = await mondayGql(`query($ids:[ID!]){assets(ids:$ids){id name public_url}}`, { ids: [String(assetId)] });
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
    .replace(/[^A-Za-z0-9._-]/g, '_')              // risky chars → underscore
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
