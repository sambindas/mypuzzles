import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
// Serve WASM with correct MIME type
app.use('/engine', express.static(path.join(__dirname, 'engine'), {
  setHeaders(res, p) { if (p.endsWith('.wasm')) res.set('Content-Type', 'application/wasm'); }
}));

app.listen(PORT, () => console.log(`→ http://localhost:${PORT}`));