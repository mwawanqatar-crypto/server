const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

const BLOCKED_FILE = path.join(__dirname, 'blocked_ips.json');
let blockedIPs = new Set();

try {
  if (fs.existsSync(BLOCKED_FILE)) {
    blockedIPs = new Set(JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8')));
  }
} catch (e) { console.error('load blocked_ips failed', e); }

function saveBlocked() {
  fs.writeFileSync(BLOCKED_FILE, JSON.stringify([...blockedIPs], null, 2));
}

function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return (req.connection?.remoteAddress || req.socket?.remoteAddress || '').replace('::ffff:', '');
}

// ====== Health check ======
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// ====== NEW: /check-block endpoint ======
// بيرجع للموقع هل الـ IP تاع الزائر محظور أو لا
app.get('/check-block', (req, res) => {
  const ip = getClientIP(req);
  const blocked = blockedIPs.has(ip);
  res.json({ blocked, ip });
});

// ====== Middleware للحظر (بعد /check-block عشان يقدر يوصل) ======
app.use((req, res, next) => {
  const ip = getClientIP(req);
  if (blockedIPs.has(ip)) {
    return res.status(403).send('403 Forbidden - Your IP has been blocked.');
  }
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

io.use((socket, next) => {
  const ip = (socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim())
    || socket.handshake.address.replace('::ffff:', '');
  if (blockedIPs.has(ip)) return next(new Error('blocked'));
  socket.data.ip = ip;
  next();
});

// ====== كاش الموقع الجغرافي لكل IP ======
const geoCache = new Map();
async function lookupGeo(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { country: 'محلي', countryCode: '', city: '' };
  }
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city&lang=ar`);
    const data = await res.json();
    if (data.status === 'success') {
      const geo = { country: data.country || '', countryCode: data.countryCode || '', city: data.city || '' };
      geoCache.set(ip, geo);
      return geo;
    }
  } catch (e) { console.warn('geo lookup failed', e.message); }
  const empty = { country: '', countryCode: '', city: '' };
  geoCache.set(ip, empty);
  return empty;
}

const activeUsers = {};

io.on('connection', (socket) => {
  socket.on('register_user', async (data) => {
    for (const sid in activeUsers) {
      if (activeUsers[sid].userId === data.userId) {
        delete activeUsers[sid];
      }
    }
    const geo = await lookupGeo(socket.data.ip);
    activeUsers[socket.id] = {
      socketId: socket.id,
      userId: data.userId,
      name: data.name || "",
      phone: data.phone || "",
      address: data.address || "",
      currentPage: data.currentPage,
      ip: socket.data.ip,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      connectedAt: new Date().toISOString(),
    };
    sendActiveUsersToAdmins();
  });

  socket.on('update_page', (data) => {
    if (activeUsers[socket.id]) {
      activeUsers[socket.id].currentPage = data.currentPage;
      sendActiveUsersToAdmins();
    }
  });

  socket.on('register_admin', () => {
    socket.join('admins_room');
    sendActiveUsersToAdmins();
  });

  socket.on('admin_redirect_user', ({ targetSocketId, redirectUrl }) => {
    io.to(targetSocketId).emit('execute_redirect', { url: redirectUrl });
  });

  socket.on('admin_show_popup', ({ targetSocketId, title, message, type }) => {
    io.to(targetSocketId).emit('show_popup', { title, message, type });
  });

  socket.on('admin_block_user', ({ targetSocketId }) => {
    const user = activeUsers[targetSocketId];
    if (!user || !user.ip) return;
    blockedIPs.add(user.ip);
    saveBlocked();
    console.log(`[BLOCK] IP ${user.ip} (${user.userId}) blocked`);
    for (const [sid, u] of Object.entries(activeUsers)) {
      if (u.ip === user.ip) {
        io.to(sid).emit('execute_redirect', { url: '/blocked' });
        const s = io.sockets.sockets.get(sid);
        if (s) setTimeout(() => s.disconnect(true), 500);
      }
    }
    sendActiveUsersToAdmins();
  });

  socket.on('disconnect', () => {
    if (activeUsers[socket.id]) {
      delete activeUsers[socket.id];
      sendActiveUsersToAdmins();
    }
  });
});

function sendActiveUsersToAdmins() {
  io.to('admins_room').emit('update_users_list', Object.values(activeUsers));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[SERVER] Port: ${PORT}`));
