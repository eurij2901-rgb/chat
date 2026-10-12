require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- КОНФИГ (секреты только из .env) ----------
const {
    MONGO_URI,
    SESSION_SECRET = crypto.randomBytes(32).toString('hex'),
    SMTP_HOST = 'smtp.mail.ru',
    SMTP_PORT = '465',
    SMTP_USER,
    SMTP_PASS,
    PORT = 3000
} = process.env;

if (!MONGO_URI) {
    console.error('❌ Не задан MONGO_URI в .env');
    process.exit(1);
}

// ---------- СЕССИИ ----------
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true, sameSite: 'lax' }
});
app.use(sessionMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Отдаём только index.html, а не весь каталог (иначе виден server.js и .env)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- ФАЙЛЫ ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const suffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
            cb(null, suffix + path.extname(file.originalname).slice(0, 10));
        }
    }),
    limits: { fileSize: 15 * 1024 * 1024 }
});
app.use('/uploads', express.static(uploadDir, {
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
}));

// ---------- БАЗА ----------
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB подключена'))
    .catch(err => console.error('❌ Ошибка MongoDB:', err));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    avatar: { type: String, default: '👤' },
    theme: { type: String, default: 'light' },
    notifications: { type: Boolean, default: true },
    contacts: [String],
    blockedUsers: [String],
    lastSeen: { type: Date, default: Date.now }
}));

const Room = mongoose.model('Room', new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    type: { type: String, default: 'private' },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    creator: String
}));

const Message = mongoose.model('Message', new mongoose.Schema({
    user: String,
    text: String,
    fileUrl: String,
    fileName: String,
    fileType: String,
    time: String,
    room: String,
    recipient: String,
    id: String,
    edited: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
}));

(async function initPublicRooms() {
    for (const name of ['General', 'Developers', 'Random']) {
        if (!(await Room.findOne({ name }))) {
            await new Room({ name, type: 'public', members: [] }).save();
        }
    }
})();

// ---------- ПОЧТА ----------
const transporter = SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST, port: Number(SMTP_PORT), secure: true,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
    : null;

const verificationCodes = new Map();

// Простой ограничитель частоты запросов
const hits = new Map();
function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length > max;
}

const publicUser = (u) => ({
    username: u.username, email: u.email, avatar: u.avatar,
    theme: u.theme, notifications: u.notifications
});
const clean = (s, max = 4000) => String(s ?? '').slice(0, max);
const requireAuth = (req, res, next) =>
    req.session?.username ? next() : res.status(401).json({ success: false, message: 'Не авторизован' });

// ---------- МАРШРУТЫ ----------
app.get('/check-session', (req, res) => {
    res.json(req.session?.username
        ? { success: true, username: req.session.username }
        : { success: false });
});

app.post('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.post('/send-code', async (req, res) => {
    try {
        if (rateLimit('code:' + req.ip, 5, 10 * 60 * 1000))
            return res.status(429).json({ success: false, message: 'Слишком много запросов, подождите.' });

        const email = clean(req.body.email, 200).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.status(400).json({ success: false, message: 'Введите корректный E-mail!' });
        if (await User.findOne({ email }))
            return res.status(400).json({ success: false, message: 'Этот E-mail уже зарегистрирован!' });
        if (!transporter)
            return res.status(500).json({ success: false, message: 'Почта на сервере не настроена.' });

        const code = crypto.randomInt(100000, 1000000).toString();
        verificationCodes.set(email, { code, expires: Date.now() + 5 * 60 * 1000, tries: 0 });

        await transporter.sendMail({
            from: `"Мой Мессенджер" <${SMTP_USER}>`,
            to: email,
            subject: 'Код подтверждения',
            html: `<h3>Ваш код: <b style="color:#00695c;font-size:24px">${code}</b></h3>
                   <p>Код действует 5 минут. Никому его не передавайте.</p>`
        });
        res.json({ success: true, message: 'Код отправлен на почту!' });
    } catch (e) {
        console.error('Ошибка письма:', e);
        res.status(500).json({ success: false, message: 'Не удалось отправить письмо.' });
    }
});

app.post('/register', async (req, res) => {
    try {
        const username = clean(req.body.username, 30).trim();
        const email = clean(req.body.email, 200).trim().toLowerCase();
        const password = clean(req.body.password, 200);
        const code = clean(req.body.code, 10).trim();

        if (!username || !email || !password || !code)
            return res.status(400).json({ success: false, message: 'Заполните все поля!' });
        if (password.length < 6)
            return res.status(400).json({ success: false, message: 'Пароль минимум 6 символов.' });
        if (!/^[\p{L}\p{N}_.\-]{2,30}$/u.test(username))
            return res.status(400).json({ success: false, message: 'Имя: 2–30 символов, буквы, цифры, _ . -' });

        const saved = verificationCodes.get(email);
        if (!saved) return res.status(400).json({ success: false, message: 'Сначала запросите код!' });
        if (Date.now() > saved.expires) {
            verificationCodes.delete(email);
            return res.status(400).json({ success: false, message: 'Код истёк, запросите новый.' });
        }
        if (++saved.tries > 5) {
            verificationCodes.delete(email);
            return res.status(400).json({ success: false, message: 'Слишком много попыток, запросите новый код.' });
        }
        if (saved.code !== code)
            return res.status(400).json({ success: false, message: 'Неверный код!' });

        if (await User.findOne({ $or: [{ username }, { email }] }))
            return res.status(400).json({ success: false, message: 'Имя или E-mail уже заняты!' });

        await new User({ username, email, password: await bcrypt.hash(password, 10) }).save();
        verificationCodes.delete(email);
        res.json({ success: true, message: 'Регистрация успешна!' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/login', async (req, res) => {
    try {
        if (rateLimit('login:' + req.ip, 10, 10 * 60 * 1000))
            return res.status(429).json({ success: false, message: 'Слишком много попыток входа.' });

        const login = clean(req.body.username, 200).trim();
        const password = clean(req.body.password, 200);
        const user = await User.findOne({ $or: [{ username: login }, { email: login.toLowerCase() }] });

        let ok = false;
        if (user) {
            if (user.password.startsWith('$2')) {
                ok = await bcrypt.compare(password, user.password);
            } else if (user.password === password) {
                // миграция старых аккаунтов с открытыми паролями
                ok = true;
                user.password = await bcrypt.hash(password, 10);
                await user.save();
            }
        }
        if (!ok) return res.status(401).json({ success: false, message: 'Неверные данные' });

        req.session.username = user.username;
        res.json({ success: true, username: user.username });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/get-profile', requireAuth, async (req, res) => {
    const user = await User.findOne({ username: req.session.username });
    user ? res.json({ success: true, user: publicUser(user) }) : res.status(404).json({ success: false });
});

app.post('/update-profile', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ username: req.session.username });
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

        const newEmail = clean(req.body.newEmail, 200).trim().toLowerCase();
        if (newEmail && newEmail !== user.email) {
            const saved = verificationCodes.get(newEmail);
            if (!saved || saved.code !== clean(req.body.code, 10).trim() || Date.now() > saved.expires)
                return res.status(400).json({ success: false, message: 'Для смены почты нужен код из письма!' });
            user.email = newEmail;
            verificationCodes.delete(newEmail);
        }

        const newUsername = clean(req.body.newUsername, 30).trim();
        if (newUsername && newUsername !== user.username) {
            if (!/^[\p{L}\p{N}_.\-]{2,30}$/u.test(newUsername))
                return res.status(400).json({ success: false, message: 'Недопустимое имя.' });
            if (await User.findOne({ username: newUsername }))
                return res.status(400).json({ success: false, message: 'Это имя уже занято!' });
            user.username = newUsername;
            req.session.username = newUsername;
        }

        if (req.body.avatar) user.avatar = clean(req.body.avatar, 300);
        if (['light', 'dark'].includes(req.body.theme)) user.theme = req.body.theme;
        if (typeof req.body.notifications === 'boolean') user.notifications = req.body.notifications;

        await user.save();
        res.json({ success: true, message: 'Настройки сохранены!', user: publicUser(user) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/upload', requireAuth, (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.file) return res.status(400).json({ success: false, message: 'Нет файла' });
        const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(req.file.mimetype);
        res.json({
            success: true,
            fileUrl: '/uploads/' + req.file.filename,
            fileName: req.file.originalname,
            fileType: isImage ? 'image' : 'file'
        });
    });
});

// ---------- SOCKET.IO ----------
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
io.use((socket, next) => {
    const name = socket.request.session?.username;
    if (!name) return next(new Error('unauthorized'));
    socket.username = name;
    next();
});

const users = {}; // username -> Set<socket>
const emitTo = (name, event, payload) => users[name]?.forEach(s => s.emit(event, payload));
const timeNow = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const newId = () => crypto.randomBytes(8).toString('hex');

async function sendUserList() {
    const online = Object.keys(users);
    const docs = await User.find({}, 'username avatar contacts').lean();
    const avatars = Object.fromEntries(docs.map(d => [d.username, d.avatar]));
    io.emit('update all active users', online.map(n => ({ username: n, avatar: avatars[n] })));

    for (const d of docs) {
        if (!users[d.username]) continue;
        const contacts = (d.contacts || []).map(n => ({
            username: n, avatar: avatars[n] || '👤', online: !!users[n]
        }));
        const potential = online
            .filter(n => n !== d.username && !(d.contacts || []).includes(n))
            .map(n => ({ username: n, avatar: avatars[n] }));
        emitTo(d.username, 'update contacts', contacts);
        emitTo(d.username, 'update potential contacts', potential);
    }
}

async function sendRoomList(username) {
    if (!users[username]) return;
    const me = await User.findOne({ username });
    if (!me) return;
    const rooms = await Room.find({ $or: [{ type: 'public' }, { members: me._id }] }, 'name type creator');
    emitTo(username, 'update room list', rooms);
}

async function canAccessRoom(username, roomName) {
    const room = await Room.findOne({ name: roomName });
    if (!room) return false;
    if (room.type === 'public') return true;
    const me = await User.findOne({ username }, '_id');
    return !!me && room.members.some(m => m.equals(me._id));
}

io.on('connection', async (socket) => {
    const me = socket.username;
    (users[me] ||= new Set()).add(socket);

    const doc = await User.findOne({ username: me });
    if (doc) socket.emit('update blocked list', doc.blockedUsers || []);
    await sendRoomList(me);
    sendUserList();

    socket.on('search user by email', async (email) => {
        const user = await User.findOne({ email: clean(email, 200).trim().toLowerCase() });
        socket.emit('search result', user
            ? { success: true, username: user.username }
            : { success: false, message: 'Пользователь с такой почтой не найден' });
    });

    socket.on('create room', async (data) => {
        try {
            const name = clean(data.name, 40).trim();
            if (!name) return socket.emit('error message', 'Введите название комнаты.');
            if (await Room.findOne({ name })) return socket.emit('error message', 'Имя комнаты занято!');

            const byName = await User.find({ username: { $in: data.memberNames || [] } }, '_id');
            const ids = new Set(byName.map(d => d._id.toString()));
            (data.memberIds || []).forEach(id => mongoose.isValidObjectId(id) && ids.add(id));
            const creator = await User.findOne({ username: me }, '_id');
            ids.add(creator._id.toString());

            await new Room({ name, type: 'private', members: [...ids], creator: me }).save();
            const members = await User.find({ _id: { $in: [...ids] } }, 'username');
            members.forEach(m => sendRoomList(m.username));
        } catch (e) {
            socket.emit('error message', 'Ошибка при создании комнаты.');
        }
    });

    socket.on('join room', async (roomName) => {
        if (!(await canAccessRoom(me, roomName))) return socket.emit('error message', 'Нет доступа к комнате.');
        [...socket.rooms].filter(r => r !== socket.id).forEach(r => socket.leave(r));
        socket.join(roomName);
        const history = await Message.find({ room: roomName }).sort({ timestamp: -1 }).limit(100);
        socket.emit('load history', history.reverse());
    });

    socket.on('join pm', async (recipient) => {
        [...socket.rooms].filter(r => r !== socket.id).forEach(r => socket.leave(r));
        const history = await Message.find({
            room: null,
            $or: [{ user: me, recipient }, { user: recipient, recipient: me }]
        }).sort({ timestamp: -1 }).limit(100);
        socket.emit('load history', history.reverse());
    });

    function buildMsg(data) {
        const text = clean(data.text);
        const fileUrl = typeof data.fileUrl === 'string' && data.fileUrl.startsWith('/uploads/') ? data.fileUrl : undefined;
        if (!text.trim() && !fileUrl) return null;
        return {
            user: me, text,
            fileUrl,
            fileName: fileUrl ? clean(data.fileName, 200) : undefined,
            fileType: fileUrl ? (data.fileType === 'image' ? 'image' : 'file') : undefined,
            time: timeNow(), id: newId()
        };
    }

    socket.on('chat message', async (data) => {
        const room = clean(data.room, 80);
        if (!(await canAccessRoom(me, room))) return;
        const msg = buildMsg(data);
        if (!msg) return;
        msg.room = room;
        await new Message(msg).save();
        io.to(room).emit('chat message', msg);
    });

    socket.on('private message', async (data) => {
        const recipient = clean(data.recipient, 40);
        const rDoc = await User.findOne({ username: recipient }, 'blockedUsers');
        if (!rDoc) return;
        if ((rDoc.blockedUsers || []).includes(me)) return;
        const msg = buildMsg(data);
        if (!msg) return;
        msg.recipient = recipient;
        msg.room = null;
        await new Message(msg).save();
        emitTo(me, 'chat message', msg);
        if (recipient !== me) emitTo(recipient, 'chat message', msg);
    });

    socket.on('delete message', async ({ id }) => {
        const msg = await Message.findOne({ id: clean(id, 40), user: me });
        if (!msg) return;
        await msg.deleteOne();
        if (msg.room) io.to(msg.room).emit('message deleted', { id: msg.id });
        else {
            emitTo(me, 'message deleted', { id: msg.id });
            emitTo(msg.recipient, 'message deleted', { id: msg.id });
        }
    });

    socket.on('typing', ({ room, recipient }) => {
        if (room) socket.to(room).emit('typing', { user: me, room });
        else if (recipient) emitTo(recipient, 'typing', { user: me, recipient });
    });

    const contactOp = (event, fn) => socket.on(event, async (name) => {
        try {
            name = clean(name, 40);
            if (!name || name === me) return;
            await fn(name);
            const d = await User.findOne({ username: me });
            socket.emit('update blocked list', d.blockedUsers || []);
            sendUserList();
        } catch (e) { console.error(e); }
    });
    contactOp('add contact', n => User.updateOne({ username: me }, { $addToSet: { contacts: n } }));
    contactOp('remove contact', n => User.updateOne({ username: me }, { $pull: { contacts: n } }));
    contactOp('block user', n => User.updateOne({ username: me },
        { $addToSet: { blockedUsers: n }, $pull: { contacts: n } }));
    contactOp('unblock user', n => User.updateOne({ username: me }, { $pull: { blockedUsers: n } }));

    socket.on('disconnect', () => {
        users[me]?.delete(socket);
        if (!users[me]?.size) delete users[me];
        User.updateOne({ username: me }, { lastSeen: new Date() }).catch(() => {});
        sendUserList();
    });
});

server.listen(PORT, () => console.log(`🚀 Сервер на порту ${PORT}`));
