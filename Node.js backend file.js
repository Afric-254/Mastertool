import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 4000;
const DERIV_WS = 'wss://ws.derivws.com/websockets/v3';
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key_change_in_production';

// ===== USER STORE (Demo - use real DB in production) =====
const users = {};

function createUser(username, password) {
  const id = Date.now().toString();
  users[username] = { id, username, password, displayName: username };
  return users[username];
}

function validateUser(username, password) {
  const u = users[username];
  return u && u.password === password ? u : null;
}

// ===== AUTH ROUTES =====
app.post('/auth/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username+password required' });
  if (users[username]) return res.status(409).json({ error: 'user exists' });
  
  const user = createUser(username, password);
  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, displayName: user.displayName } });
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = validateUser(username, password);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  
  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, displayName: user.displayName } });
});

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'missing token' });
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// ===== DERIV CONNECTIVITY =====
app.get('/api/deriv/status', async (req, res) => {
  const ws = new WebSocket(DERIV_WS);
  const timeout = setTimeout(() => {
    ws.terminate?.();
    res.status(504).json({ ok: false, error: 'timeout' });
  }, 5000);

  ws.on('open', () => {
    ws.send(JSON.stringify({ website_status: 1, req_id: 1 }));
  });

  ws.on('message', (msg) => {
    clearTimeout(timeout);
    try {
      const data = JSON.parse(msg.toString());
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'parse error' });
    } finally {
      ws.close();
    }
  });

  ws.on('error', () => {
    clearTimeout(timeout);
    res.status(502).json({ ok: false, error: 'ws error' });
  });
});

// ===== DERIV RELAY (WebSocket connection to Deriv) =====
let derivConnection = null;

function connectDerivAndRelay() {
  if (derivConnection && derivConnection.readyState === WebSocket.OPEN) return;
  
  derivConnection = new WebSocket(DERIV_WS);

  derivConnection.on('open', () => {
    console.log('[Deriv] Connected');
    derivConnection.send(JSON.stringify({ website_status: 1, req_id: 1 }));
    io.emit('deriv:connected', { timestamp: new Date() });
  });

  derivConnection.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      io.emit('deriv:data', data);
    } catch (e) {
      // ignore
    }
  });

  derivConnection.on('close', () => {
    console.log('[Deriv] Closed — reconnecting in 3s');
    setTimeout(connectDerivAndRelay, 3000);
  });

  derivConnection.on('error', (e) => {
    console.log('[Deriv] Error:', e.message);
  });
}

connectDerivAndRelay();

// ===== DERIV SUBSCRIBE ENDPOINT =====
app.post('/api/deriv/subscribe', requireAuth, (req, res) => {
  const { subscribe_request } = req.body;
  if (!derivConnection || derivConnection.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ ok: false, error: 'deriv-not-connected' });
  }
  derivConnection.send(JSON.stringify(subscribe_request));
  res.json({ ok: true });
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('bot:trade', (trade) => {
    console.log('Trade:', trade);
    io.emit('bot:trade', trade);
  });

  socket.on('request-subscribe', (payload) => {
    if (derivConnection && derivConnection.readyState === WebSocket.OPEN) {
      derivConnection.send(JSON.stringify(payload));
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

// ===== START SERVER =====
server.listen(PORT, () => {
  console.log(`🚀 Mastertool server running on http://localhost:${PORT}`);
});