const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session'); // ДОБАВЛЕНО: модуль сессий

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const nodemailer = require('nodemailer');

// --- НАСТРОЙКА СЕССИЙ ---
app.use(session({
    secret: 'my-super-secret-chat-key', // Секретный ключ для шифрования сессии
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 * 30 // Сессия живет 30 дней
    }
}));

app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// --- 1. НАСТРОЙКА ФАЙЛОВ (MULTER) ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- 2. БАЗА ДАННЫХ ---
mongoose.connect('mongodb+srv://eurij2901_db_user:S1dFJmbCBLCllTVE@cluster0.dqosu5r.mongodb.net/mychat?appName=Cluster0')
    .then(() => console.log('✅ Успешное подключение к MongoDB Atlas!'))
    .catch(err => console.error('❌ Ошибка подключения:', err));

// --- СХЕМЫ ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    avatar: { type: String, default: '👤' },
    theme: { type: String, default: 'light' },
    notifications: { type: Boolean, default: true },
    contacts: [{ type: String }],       // ДОБАВЛЕНО для стабильности
    blockedUsers: [{ type: String }]    // ДОБАВЛЕНО для стабильности
});
const User = mongoose.model('User', userSchema);

const RoomSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    type: { type: String, default: 'private' },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    creator: String
});
const Room = mongoose.model('Room', RoomSchema);

const MessageSchema = new mongoose.Schema({
    user: String,
    text: String,
    fileUrl: String,
    fileName: String,
    fileType: String,
    time: String,
    room: String,      
    recipient: String, 
    id: String,        
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

async function initPublicRooms() {
    const publicRooms = ['General', 'Developers', 'Random'];
    for (const name of publicRooms) {
        const exists = await Room.findOne({ name });
        if (!exists) {
            await new Room({ name, type: 'public', members: [] }).save();
            console.log(`📢 Создана общая комната: ${name}`);
        }
    }
}
initPublicRooms(); // Вызываем создание комнат при старте

// --- 3. МАРШРУТЫ ---
const verificationCodes = new Map();

const transporter = nodemailer.createTransport({
    host: 'smtp.mail.ru', 
    port: 465,                  
    secure: true,               
    auth: {
        user: 'go.play.world@mail.ru',
        pass: 'zQAkDxoYJXMtawwStt54' 
    }
});

// Проверка сессии при перезагрузке страницы
app.get('/check-session', (req, res) => {
    if (req.session && req.session.username) {
        res.json({ success: true, username: req.session.username });
    } else {
        res.json({ success: false });
    }
});

// Выход из аккаунта
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.post('/send-code', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, message: 'Введите корректный E-mail!' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Этот E-mail уже зарегистрирован!' });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        verificationCodes.set(email, { code: code, expires: Date.now() + 300000 });

        await transporter.sendMail({
            from: '"Мой Мессенджер" go.play.world@mail.ru',
            to: email,
            subject: 'Код подтверждения регистрации',
            html: `<h3>Ваш код подтверждения: <b style="color: #00695c; font-size: 24px;">${code}</b></h3>
                <p>Код действителен в течение 5 минут. Не передавайте его никому!</p>`
        });
        res.json({ success: true, message: 'Код подтверждения отправлен на вашу почту!' });

    } catch (error) {
        console.error('Ошибка отправки письма:', error);
        res.status(500).json({ success: false, message: 'Не удалось отправить письмо. Проверьте настройки почты!' });
    }
});

app.post('/register', async (req, res) => {
    try {
        const { username, email, password, code } = req.body;

        if (!username || !email || !password || !code) {
            return res.status(400).json({ success: false, message: 'Заполните абсолютно все поля!' });
        }

        const savedData = verificationCodes.get(email);

        if (!savedData) return res.status(400).json({ success: false, message: 'Сначала запросите код на почту!' });
        if (Date.now() > savedData.expires) {
            verificationCodes.delete(email);
            return res.status(400).json({ success: false, message: 'Время действия кода истекло! Запросите новый.' });
        }
        if (savedData.code !== code.trim()) return res.status(400).json({ success: false, message: 'Неверный код подтверждения!' });

        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) return res.status(400).json({ success: false, message: 'Пользователь с таким именем или E-mail уже существует!' });

        await new User({ username, email, password }).save();
        verificationCodes.delete(email);

        res.json({ success: true, message: 'Регистрация успешна!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ $or: [{ username: username }, { email: username }] });
        
        if (user && user.password === password) {
            // СОХРАНЯЕМ СЕССИЮ
            req.session.username = user.username; 
            res.json({ success: true, message: 'Вход выполнен!', username: user.username });
        } else {
            res.status(401).json({ success: false, message: 'Неверные данные' });
        }
    } catch (e) { 
        res.status(500).json({ success: false }); 
    }
});

app.post('/get-profile', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.body.username });
        if (user) res.json({ success: true, user });
        else res.status(404).json({ success: false });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/update-profile', async (req, res) => {
    try {
        const { currentUsername, newUsername, avatar, theme, notifications, newEmail, code } = req.body;
        const user = await User.findOne({ username: currentUsername });
        
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

        if (newEmail && newEmail !== 'undefined' && newEmail.trim() !== '' && newEmail !== user.email) {
            const savedData = verificationCodes.get(newEmail);
            if (!savedData || savedData.code !== (code ? code.trim() : '') || Date.now() > savedData.expires) {
                return res.status(400).json({ success: false, message: 'Для смены почты нужен код из нового письма!' });
            }
            user.email = newEmail;
            verificationCodes.delete(newEmail);
        }

        if (newUsername && newUsername !== currentUsername) {
            const existing = await User.findOne({ username: newUsername });
            if (existing) return res.status(400).json({ success: false, message: 'Это имя уже занято!' });
            user.username = newUsername;
            // Обновляем имя в сессии
            req.session.username = newUsername;
        }

        if (avatar) user.avatar = avatar;
        if (theme) user.theme = theme;
        user.notifications = notifications !== undefined ? notifications : user.notifications;

        await user.save();
        res.json({ success: true, message: 'Настройки сохранены!', user });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'Нет файла' });
    const isImage = req.file.mimetype.startsWith('image/');
    res.json({ 
        success: true, 
        fileUrl: '/uploads/' + req.file.filename,
        fileName: req.file.originalname,
        fileType: isImage ? 'image' : 'file'
    });
});

// --- 4. SOCKET.IO И ФУНКЦИИ ---
const users = {}; 

async function sendUserList() {
    const activeUsernames = Object.keys(users);
    io.emit('update all active users', activeUsernames.map(name => ({ username: name })));

    for (const username of activeUsernames) {
        if (!users[username]) continue;
        
        const userDoc = await User.findOne({ username });
        if (!userDoc) continue;
        
        const userContacts = userDoc.contacts || [];
        const onlineContacts = [];
        const potentialContacts = [];

        activeUsernames.forEach(onlineUser => {
            if (onlineUser === username) return;
            if (userContacts.includes(onlineUser)) {
                onlineContacts.push({ username: onlineUser });
            } else {
                potentialContacts.push({ username: onlineUser });
            }
        });

        users[username].emit('update online contacts', onlineContacts);
        users[username].emit('update potential contacts', potentialContacts);
    }
}

async function sendRoomList(username) {
    const userSocket = users[username];
    if (!userSocket) return;
    
    const currentUser = await User.findOne({ username });
    if (!currentUser) return;

    const rooms = await Room.find({
        $or: [
            { type: 'public' },
            { members: currentUser._id } 
        ]
    }).populate('members', 'username'); 
    
    userSocket.emit('update room list', rooms);
}

io.on('connection', (socket) => {
    socket.on('set username', async (username) => {
        socket.username = username;
        users[username] = socket;

        const userDoc = await User.findOne({ username });
        if (userDoc) {
            socket.emit('update contact list', userDoc.contacts);
            socket.emit('update blocked list', userDoc.blockedUsers);
        }

        await sendRoomList(username);
        sendUserList();
    });

    socket.on('search user by email', async (email) => {
        try {
            const user = await User.findOne({ email });
            if (user) {
                socket.emit('search result', { success: true, username: user.username, email: user.email });
            } else {
                socket.emit('search result', { success: false, message: 'Пользователь с такой почтой не найден' });
            }
        } catch (error) { console.error(error); }
    });

    socket.on('create room', async (data) => {
        try {
            const { name, memberNames, memberIds } = data;
            const existing = await Room.findOne({ name });
            if (existing) {
                socket.emit('error message', 'Имя комнаты занято!');
                return;
            }

            const creatorDoc = await User.findOne({ username: socket.username });
            if (!creatorDoc) return; 

            const memberDocsByName = await User.find({ username: { $in: memberNames } });
            let finalIds = memberDocsByName.map(doc => doc._id.toString());

            if (memberIds && memberIds.length > 0) {
                memberIds.forEach(id => {
                    if (!finalIds.includes(id)) finalIds.push(id);
                });
            }
            
            const creatorIdString = creatorDoc._id.toString();
            if (!finalIds.includes(creatorIdString)) finalIds.push(creatorIdString);

            const newRoom = new Room({
                name,
                type: 'private',
                members: finalIds,
                creator: socket.username
            });
            await newRoom.save();

            const membersToNotify = await User.find({ _id: { $in: finalIds } });
            membersToNotify.forEach(member => {
                sendRoomList(member.username);
            });

        } catch (e) {
            console.error(e);
            socket.emit('error message', 'Ошибка при создании комнаты (проверьте ID).');
        }
    });

    socket.on('join room', async (roomName) => {
        socket.leaveAll(); 
        socket.join(roomName);
        socket.currentRoom = roomName;
        
        const history = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(50);
        socket.emit('load history', history);
    });

    socket.on('join pm', async (recipient) => {
        socket.currentRoom = null;
        const history = await Message.find({
            $or: [ { user: socket.username, recipient: recipient }, { user: recipient, recipient: socket.username } ],
            room: null
        }).sort({ timestamp: 1 }).limit(50);
        socket.emit('load history', history);
    });

    socket.on('chat message', async (data) => {
        const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const msgData = { 
            user: socket.username, 
            text: data.text || '', 
            fileUrl: data.fileUrl,
            fileName: data.fileName,
            fileType: data.fileType,
            room: data.room, 
            time, 
            id: Date.now().toString() 
        };
        await new Message(msgData).save();
        io.to(data.room).emit('chat message', msgData);
    });

    socket.on('private message', async (data) => {
        const senderDoc = await User.findOne({ username: socket.username });
        const recipientDoc = await User.findOne({ username: data.recipient });
        
        if (recipientDoc && recipientDoc.blockedUsers && recipientDoc.blockedUsers.includes(socket.username)) {
            return; 
        }
        
        const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const msgData = { 
            user: socket.username, 
            recipient: data.recipient, 
            text: data.text || '', 
            fileUrl: data.fileUrl,
            fileName: data.fileName,
            fileType: data.fileType,
            room: null, 
            time, 
            id: data.id 
        };
        await new Message(msgData).save();
        
        socket.emit('chat message', msgData);
        if (users[data.recipient]) users[data.recipient].emit('chat message', msgData);
    });

    socket.on('add contact', async (contactName) => {
        try {
            if (!socket.username || socket.username === contactName) return;
            await User.updateOne({ username: socket.username }, { $addToSet: { contacts: contactName } });
            const updatedUser = await User.findOne({ username: socket.username });
            socket.emit('update contact list', updatedUser.contacts);
            sendUserList();
        } catch (e) { console.error(e); }
    });

    socket.on('remove contact', async (contactName) => {
        try {
            if (!socket.username) return;
            await User.updateOne({ username: socket.username }, { $pull: { contacts: contactName } });
            socket.emit('error message', `Контакт ${contactName} удален.`);
            sendUserList();
        } catch (e) { console.error(e); }
    });

    socket.on('block user', async (blockedName) => {
        try {
            if (!socket.username) return;
            await User.updateOne(
                { username: socket.username },
                { $addToSet: { blockedUsers: blockedName }, $pull: { contacts: blockedName } }
            );
            const updatedUser = await User.findOne({ username: socket.username });
            socket.emit('update contact list', updatedUser.contacts);
            socket.emit('update blocked list', updatedUser.blockedUsers); 
            sendUserList();
        } catch (e) { console.error(e); }
    });

    socket.on('unblock user', async (unblockedName) => {
        try {
            if (!socket.username) return;
            await User.updateOne({ username: socket.username }, { $pull: { blockedUsers: unblockedName } });
            const updatedUser = await User.findOne({ username: socket.username }); 
            socket.emit('update blocked list', updatedUser.blockedUsers);
            socket.emit('error message', `Пользователь ${unblockedName} разблокирован.`);
            sendUserList();
        } catch (e) { console.error(e); }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            delete users[socket.username];
            sendUserList();
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 Сервер: http://localhost:${PORT}`));