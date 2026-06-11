const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// Token comes from Render env var MONDAY_TOKEN; falls back to hardcoded
const MONDAY_TOKEN = process.env.MONDAY_TOKEN || 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0MjE2NDAwMywiYWFpIjoxMSwidWlkIjoyMzMyNTE1NywiaWFkIjoiMjAyNi0wNC0wNlQyMDo0NTowMC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6ODgyNjM1NywicmduIjoidXNlMSJ9.eI5q0d8WflnpvZh1Tno_xBcI7DGJpkL9-p-iTMiH7YA';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

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
