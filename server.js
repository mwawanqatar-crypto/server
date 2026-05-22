const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
    || socket.handshake.address.replace('::ffff:', '');
  if (blockedIPs.has(ip)) {
    return next(new Error('blocked'));
  }
  socket.data.ip = ip;
  next();
});

const activeUsers = {};

io.on('connection', (socket) => {
  socket.on('register_user', (data) => {
    activeUsers[socket.id] = {
      socketId: socket.id,
      userId: data.userId,
      currentPage: data.currentPage,
      ip: socket.data.ip,
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

  // ====== حظر مستخدم عبر الـ IP ======
  socket.on('admin_block_user', ({ targetSocketId }) => {
    const user = activeUsers[targetSocketId];
    if (!user || !user.ip) return;
    blockedIPs.add(user.ip);
    saveBlocked();
    console.log(`[BLOCK] IP ${user.ip} (${user.userId}) blocked`);

    // اطرد كل الجلسات النشطة بنفس الـ IP
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
