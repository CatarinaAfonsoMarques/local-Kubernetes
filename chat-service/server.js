import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { MessagesRepo } from './messages.js';
import { GroupsRepo } from './groups.js';

const PORT = Number(process.env.PORT) || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const AUTH_URL = process.env.AUTH_URL; // optional: http://auth-service:3001
const SOCKET_IO_PATH = process.env.SOCKET_IO_PATH || '/socket.io';

const app = express();
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.options('*', cors());

app.use(express.json());

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  path: SOCKET_IO_PATH,
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] }
});

const messages = new MessagesRepo();
const groups = new GroupsRepo();

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// DMs: recent messages for a conversation
app.get('/messages', authMiddleware(JWT_SECRET), async (req, res) => {
  const me = req.user.username;
  const peer = (req.query.with || '').toString().trim();
  if (!peer) return res.status(400).json({ error: 'missing query parameter: with' });
  const convId = dmConvIdFor(me, peer);
  const recent = await messages.recent(convId, 50);
  res.json(recent);
});

// Unified recent conversations (DMs + Groups)
app.get('/conversations', authMiddleware(JWT_SECRET), async (req, res) => {
  const me = req.user.username;
  const list = await messages.recentConversations(me, 30);
  res.json(list);
});

// Groups: create, list, manage members
app.post('/groups', authMiddleware(JWT_SECRET), async (req, res) => {
  try {
    const me = req.user.username;
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const g = await groups.create({ name, creator: me });
    res.status(201).json({ id: g.id, name: g.name, members: g.members });
  } catch (e) {
    console.error('create group error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/groups', authMiddleware(JWT_SECRET), async (req, res) => {
  try {
    const me = req.user.username;
    const list = await groups.listForUser(me);
    res.json(list.map(g => ({ id: g.id, name: g.name, members: g.members })));
  } catch (e) {
    console.error('list groups error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/groups/:id/members', authMiddleware(JWT_SECRET), async (req, res) => {
  try {
    const me = req.user.username;
    const id = (req.params.id || '').toString();
    const username = (req.body?.username || '').toString().trim();
    if (!username) return res.status(400).json({ error: 'username is required' });

    // Optional server-side validation via auth-service
    if (AUTH_URL) {
      try {
        const r = await fetch(`${AUTH_URL}/users/${encodeURIComponent(username)}`);
        if (r.status === 404) return res.status(404).json({ error: 'user does not exist' });
      } catch {}
    }

    const isMember = await groups.isMember(id, me);
    if (!isMember) return res.status(403).json({ error: 'not a member of this group' });

    const g = await groups.addMember(id, username);
    if (!g) return res.status(404).json({ error: 'group not found' });
    res.json({ id: g.id, name: g.name, members: g.members });
  } catch (e) {
    console.error('add member error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Socket.IO auth
io.use((socket, next) => {
  const hdr = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
  let token = hdr;
  if (hdr && typeof hdr === 'string' && hdr.startsWith('Bearer ')) token = hdr.slice(7);
  if (!token) return next(new Error('missing token'));
  try {
    const user = jwt.verify(token, JWT_SECRET);
    socket.user = user;
    next();
  } catch {
    next(new Error('invalid token'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user; // { sub, username }
  socket.join(userRoomFor(user.username));

  // DMs
  socket.on('chat:open', async (payload = {}) => {
    try {
      const peer = (payload.with || '').toString().trim();
      if (!peer) return socket.emit('chat:error', { error: 'recipient is required' });
      if (equalsIgnoreCase(peer, user.username)) {
        return socket.emit('chat:error', { error: 'cannot chat with yourself' });
      }
      const convId = dmConvIdFor(user.username, peer);
      socket.join(convId);
      const recent = await messages.recent(convId, 50);
      socket.emit('chat:history', {
        conversationId: convId,
        with: peer,
        messages: recent
      });
    } catch (e) {
      console.error('chat:open error', e);
      socket.emit('chat:error', { error: 'failed to open chat' });
    }
  });

  socket.on('chat:send', async (payload = {}) => {
    try {
      const text = (payload.text || '').toString().slice(0, 1000).trim();
      const to = (payload.to || '').toString().trim();
      if (!to) return socket.emit('chat:error', { error: 'recipient is required' });
      if (!text) return;
      if (equalsIgnoreCase(to, user.username)) {
        return socket.emit('chat:error', { error: 'cannot chat with yourself' });
      }
      const convId = dmConvIdFor(user.username, to);
      socket.join(convId);
      const msg = {
        id: uuidv4(),
        type: 'dm',
        convId,
        from: user.username,
        to,
        text,
        at: new Date().toISOString(),
        participantsLower: sortedLower(user.username, to)
      };
      await messages.save(msg);
      io.to(convId).emit('chat:message', msg);

      // Notify both participants
      const toSummary = convSummaryDMForViewer(msg, to);
      const fromSummary = convSummaryDMForViewer(msg, user.username);
      io.to(userRoomFor(to)).emit('chat:notify', toSummary);
      io.to(userRoomFor(user.username)).emit('chat:notify', fromSummary);
    } catch (e) {
      console.error('chat:send error', e);
      socket.emit('chat:error', { error: 'failed to send message' });
    }
  });

  // Groups
  socket.on('group:open', async (payload = {}) => {
    try {
      const groupId = (payload.groupId || '').toString().trim();
      if (!groupId) return socket.emit('chat:error', { error: 'groupId is required' });
      const g = await groups.findById(groupId);
      if (!g) return socket.emit('chat:error', { error: 'group not found' });
      const member = await groups.isMember(groupId, user.username);
      if (!member) return socket.emit('chat:error', { error: 'not a member of this group' });

      const convId = groupConvIdFor(groupId);
      socket.join(convId);
      const recent = await messages.recent(convId, 50);
      socket.emit('group:history', { groupId, name: g.name, conversationId: convId, messages: recent });
    } catch (e) {
      console.error('group:open error', e);
      socket.emit('chat:error', { error: 'failed to open group' });
    }
  });

  socket.on('group:send', async (payload = {}) => {
    try {
      const groupId = (payload.groupId || '').toString().trim();
      const text = (payload.text || '').toString().slice(0, 1000).trim();
      if (!groupId) return socket.emit('chat:error', { error: 'groupId is required' });
      if (!text) return;
      const g = await groups.findById(groupId);
      if (!g) return socket.emit('chat:error', { error: 'group not found' });
      const member = await groups.isMember(groupId, user.username);
      if (!member) return socket.emit('chat:error', { error: 'not a member of this group' });

      const convId = groupConvIdFor(groupId);
      socket.join(convId);

      const msg = {
        id: uuidv4(),
        type: 'group',
        convId,
        groupId,
        groupName: g.name,
        from: user.username,
        text,
        at: new Date().toISOString(),
        participantsLower: g.membersLower.slice().sort()
      };
      await messages.save(msg);

      io.to(convId).emit('group:message', msg);

      const summary = {
        convId,
        type: 'group',
        with: g.name,
        lastFrom: msg.from,
        lastMessageText: msg.text,
        lastMessageAt: msg.at
      };
      g.membersLower.forEach(mLower => {
        io.to(userRoomFor(mLower)).emit('chat:notify', summary);
      });
    } catch (e) {
      console.error('group:send error', e);
      socket.emit('chat:error', { error: 'failed to send message' });
    }
  });

  socket.on('disconnect', () => {});
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`chat-service listening on http://0.0.0.0:${PORT}`);
});

// Helpers
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
function dmConvIdFor(a, b) {
  const [x, y] = [a, b].map(s => s.toLowerCase());
  const [left, right] = [x, y].sort();
  return `dm:${left}__${right}`;
}
function groupConvIdFor(groupId) {
  return `grp:${groupId}`;
}
function sortedLower(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort();
}
function equalsIgnoreCase(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}
function userRoomFor(username) {
  return `user:${(username || '').toLowerCase()}`;
}
function convSummaryDMForViewer(msg, viewer) {
  const viewerLower = (viewer || '').toLowerCase();
  const other = (msg.from || '').toLowerCase() !== viewerLower ? msg.from : msg.to;
  return {
    convId: msg.convId,
    type: 'dm',
    with: other,
    lastFrom: msg.from,
    lastMessageText: msg.text,
    lastMessageAt: msg.at
  };
}