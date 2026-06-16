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
    form.append('variables[file]', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('interview-tool listening on', PORT));
