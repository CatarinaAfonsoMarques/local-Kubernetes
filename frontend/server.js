import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Runtime config for the browser
app.get('/env.js', (_req, res) => {
  const cfg = {
    AUTH_URL: process.env.AUTH_URL || '',
    CHAT_URL: process.env.CHAT_URL || '',
    SOCKET_PATH: process.env.SOCKET_PATH || '' // e.g. '/chat/socket.io' on K8s Ingress
  };
  res.type('application/javascript');
  // Prevent caching so updates take effect immediately
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(`window.ENV = ${JSON.stringify(cfg)};`);
});

// Static assets
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Bind to 0.0.0.0 for Docker/K8s
app.listen(PORT, '0.0.0.0', () => {
  console.log(`frontend listening on http://0.0.0.0:${PORT}`);
});