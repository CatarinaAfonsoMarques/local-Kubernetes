import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UsersRepo } from './users.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

app.use(express.json());

const users = new UsersRepo();

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Register
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const existing = await users.findByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'username already exists' });
    }
    const hash = await bcrypt.hash(password, 10);
    const created = await users.create({ username, passwordHash: hash });
    return res.status(201).json({ id: created.id, username: created.username });
  } catch (e) {
    console.error('Register error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Login
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const user = await users.findByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  } catch (e) {
    console.error('Login error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Who am I
app.get('/me', authMiddleware(JWT_SECRET), async (req, res) => {
  res.json({ id: req.user.sub, username: req.user.username });
});

// Validate recipient existence
app.get('/users/:username', async (req, res) => {
  try {
    const username = (req.params.username || '').toString().trim();
    if (!username) return res.status(400).json({ error: 'username is required' });
    const user = await users.findByUsername(username);
    if (!user) return res.status(404).json({ exists: false });
    return res.json({ exists: true, id: user.id, username: user.username });
  } catch (e) {
    console.error('users/:username error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`auth-service listening on http://0.0.0.0:${PORT}`);
});

function authMiddleware(secret) {
  return (req, res, next) => {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    try {
      req.user = jwt.verify(token, secret);
      next();
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }
  };
}