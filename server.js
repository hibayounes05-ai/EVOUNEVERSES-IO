'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const localOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || localOrigins.join(',')).split(',').map(s => s.trim()).filter(Boolean));
const io = new Server(server, {
  cors: { origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)), methods: ['GET', 'POST'] },
  pingInterval: 25000, pingTimeout: 20000,
  maxHttpBufferSize: 16 * 1024,
  perMessageDeflate: false
});
const ROOT = __dirname;
const players = new Map();
const playerSystems = new Map();
const worldSystems = new Map();
const collisionCooldowns = new Map();
let nextSystemId = 1;
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, game: 'EVOUNEVERSES IO', players: players.size, systems: worldSystems.size, mode: 'multiplayer-prototype' }));
app.use(express.static(ROOT, { extensions: ['html'], dotfiles: 'deny', index: 'index.html' }));
function cleanName(value) { return String(value || 'Explorer').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Explorer'; }
function finiteBound(value, limit, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : fallback; }
function publicPlayers() { return [...players.entries()].map(([id, p]) => ({ id, ...p })); }
function publicSystems() { return [...worldSystems.values()]; }
function broadcastPlayers() { io.emit('players', publicPlayers()); }
function broadcastSystems() { io.emit('world:systems', publicSystems()); }
function resolvePlayerCollisions() {
  const entries = [...players.entries()];
  const now = Date.now();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i], [idB, b] = entries[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let distance = Math.hypot(dx, dy);
      const minDistance = a.r + b.r + 2;
      if (distance >= minDistance) continue;
      if (distance < 0.001) {
        const seed = [...(idA + idB)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
        const angle = (seed % 360) * Math.PI / 180;
        dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
      }
      const nx = dx / distance, ny = dy / distance;
      const push = (minDistance - distance) / 2 + 1;
      a.x = finiteBound(a.x + nx * push, 145000);
      a.y = finiteBound(a.y + ny * push, 145000);
      b.x = finiteBound(b.x - nx * push, 145000);
      b.y = finiteBound(b.y - ny * push, 145000);
      const key = [idA, idB].sort().join(':');
      const lastHit = collisionCooldowns.get(key) || 0;
      const hit = now - lastHit >= 650;
      if (hit) {
        collisionCooldowns.set(key, now);
        a.hp = Math.max(0, a.hp - (a.isStar ? 2 : 5));
        b.hp = Math.max(0, b.hp - (b.isStar ? 2 : 5));
      }
      io.to(idA).emit('player:correct', { x: a.x, y: a.y, hp: a.hp, hit, otherName: b.name });
      io.to(idB).emit('player:correct', { x: b.x, y: b.y, hp: b.hp, hit, otherName: a.name });
    }
  }
}
function createSystem(name, x, y, owner = null) {
  const id = 'world-' + nextSystemId++;
  const system = { id, name: cleanName(name || ('Unclaimed System ' + nextSystemId)), x: finiteBound(x, 120000), y: finiteBound(y, 120000), r: 18 + (nextSystemId % 25), color: owner ? '#ffbd66' : '#8fcfff', owner, baselineName: cleanName(name || 'Unclaimed System'), baselineX: finiteBound(x, 120000), baselineY: finiteBound(y, 120000), baselineR: 18 + (nextSystemId % 25) };
  worldSystems.set(id, system);
  return system;
}
function resetPlayerSystem(socketId) {
  const id = playerSystems.get(socketId);
  if (!id) return;
  const system = worldSystems.get(id);
  if (system) {
    // Return the player's system to its neutral baseline when they disconnect.
    system.name = system.baselineName;
    system.x = system.baselineX;
    system.y = system.baselineY;
    system.r = system.baselineR;
    system.color = '#8fcfff';
    system.owner = null;
  }
  playerSystems.delete(socketId);
  // Replenish the universe with another neutral system.
  const angle = Math.random() * Math.PI * 2;
  const radius = 65000 + Math.random() * 52000;
  createSystem('New Frontier ' + nextSystemId, Math.cos(angle) * radius, Math.sin(angle) * radius, null);
  broadcastSystems();
}
io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return next(new Error('Origin not allowed'));
  next();
});
io.on('connection', socket => {
  let lastMove = 0;
  socket.on('join', data => {
    const old = players.get(socket.id) || {};
    let spawn = { x: 0, y: 0 };
    // Pick a clear starting point so newly joined players do not stack together.
    for (let attempt = 0; attempt < 80; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 700 + Math.random() * 1800;
      const candidate = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      const clear = [...players.values()].every(other => Math.hypot(candidate.x - other.x, candidate.y - other.y) > other.r + 120);
      if (clear) { spawn = candidate; break; }
    }
    players.set(socket.id, { name: cleanName(data && data.name || old.name), x: spawn.x, y: spawn.y, r: Math.max(7, Math.min(100, Number(data && data.r) || 12)), level: Math.max(1, Math.min(200, Number(data && data.level) || 1)), isStar: !!(data && data.isStar), hp: Math.max(0, Math.min(100000, Number(data && data.hp) || 100)), maxHp: Math.max(1, Math.min(100000, Number(data && data.maxHp) || 100)) });
    socket.emit('player:spawn', spawn);
    if (!playerSystems.has(socket.id)) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 65000 + Math.random() * 52000;
      const sys = createSystem('Explorer System ' + cleanName(data && data.name), Math.cos(angle) * radius, Math.sin(angle) * radius, null);
      playerSystems.set(socket.id, sys.id);
    }
    socket.emit('news', 'وصلت إلى قطاع جماعي تجريبي. لا تشارك معلومات شخصية في اسم اللاعب.');
    socket.emit('world:systems', publicSystems());
    socket.emit('players', publicPlayers());
    broadcastPlayers();
  });
  socket.on('player:name', name => { const p = players.get(socket.id); if (p) { p.name = cleanName(name); broadcastPlayers(); } });
  socket.on('player:move', data => {
    const now = Date.now();
    if (now - lastMove < 80) return;
    lastMove = now;
    const p = players.get(socket.id); if (!p || !data || typeof data !== 'object') return;
    const x = Number(data.x), y = Number(data.y), r = Number(data.r), level = Number(data.level);
    if (Number.isFinite(x) && Number.isFinite(y)) { p.x = finiteBound(x, 145000); p.y = finiteBound(y, 145000); }
    p.name = cleanName(data.name || p.name); p.r = Number.isFinite(r) ? Math.max(7, Math.min(100, r)) : 12; p.level = Number.isFinite(level) ? Math.max(1, Math.min(200, level)) : 1; p.isStar = !!data.isStar; p.hp = Number.isFinite(Number(data.hp)) ? Math.max(0, Math.min(100000, Number(data.hp))) : (p.hp || 100); p.maxHp = Number.isFinite(Number(data.maxHp)) ? Math.max(1, Math.min(100000, Number(data.maxHp))) : (p.maxHp || 100);
    resolvePlayerCollisions();
    io.emit('players', publicPlayers());
  });
  socket.on('player:system:claim', data => {
    const id = playerSystems.get(socket.id), sys = id && worldSystems.get(id);
    if (!sys || !data || typeof data !== 'object') return;
    sys.name = cleanName(data.name || sys.name);
    sys.x = finiteBound(data.x, 120000, sys.x);
    sys.y = finiteBound(data.y, 120000, sys.y);
    const r = Number(data.r); sys.r = Number.isFinite(r) ? Math.max(10, Math.min(100, r)) : sys.r;
    sys.color = '#ffbd66'; sys.owner = socket.id;
    io.emit('world:system', sys);
  });
  socket.on('disconnect', () => {
    players.delete(socket.id);
    for (const key of collisionCooldowns.keys()) if (key.includes(socket.id)) collisionCooldowns.delete(key);
    resetPlayerSystem(socket.id);
    io.emit('player:left', socket.id);
    broadcastPlayers();
  });
});
const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => console.log(`EVOUNEVERSES IO multiplayer prototype running on port ${port}`));
