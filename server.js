import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Use a stable default port for local dev.
// (Some runtimes inject PORT automatically; we intentionally ignore it here.)
const PORT = 5177;

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    // Helpful when iterating quickly
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`QBO Dashboard running on http://localhost:${PORT}`);
});
