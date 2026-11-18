const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'rooms-state.json');

// Хранилище комнат: pin (4 цифры) -> объект состояния
const rooms = new Map();
// Подписчики SSE по pin: pin -> Set(res)
const clients = new Map();

function saveState() {
  try {
    const obj = Object.fromEntries(rooms);
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка сохранения состояния:', err.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const obj = JSON.parse(raw || '{}');
    for (const [pin, room] of Object.entries(obj)) {
      if (/^\d{4}$/.test(pin) && room && typeof room === 'object') {
        rooms.set(pin, room);
      }
    }
    console.log(`Восстановлено комнат из файла: ${rooms.size}`);
  } catch (err) {
    console.error('Ошибка загрузки состояния:', err.message);
  }
}

/**
 * Возвращает первый не-loopback IPv4 адрес машины в локальной сети (для QR-кодов в Wi-Fi).
 */
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = typeof net.family === 'string' ? net.family : String(net.family);
      if ((family === 'IPv4' || family === '4') && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

const LAN_IP = getLanIp();
const LAN_ORIGIN = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;

/**
 * Генерирует уникальный 4-значный PIN-код от 1000 до 9999.
 */
function generateUniquePin() {
  for (let i = 0; i < 10000; i++) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(pin)) {
      return pin;
    }
  }
  throw new Error('Все 4-значные PIN-коды заняты');
}

/**
 * Создаёт новую изолированную комнату (или возвращает существующую, если передан requestedPin).
 */
function createRoom(requestedPin = null) {
  let pin;
  if (requestedPin !== null && requestedPin !== undefined && requestedPin !== '') {
    const clean = String(requestedPin).trim();
    if (!/^\d{4}$/.test(clean)) {
      throw new Error('PIN должен состоять из 4 цифр');
    }
    if (rooms.has(clean)) {
      return rooms.get(clean);
    }
    pin = clean;
  } else {
    pin = generateUniquePin();
  }

  const room = {
    pin,
    status: 'idle', // 'idle' | 'running' | 'paused'
    durationSec: 900, // 15 минут по умолчанию
    remainingMs: 900 * 1000,
    endTimeMs: null,
    message: '',
    showMessage: false,
    settings: {
      blackBackground: false,  // false = цветной фон, true = чёрный экран и цветные цифры
      yellowThresholdSec: 300, // за 5 минут (300 сек)
      redThresholdSec: 60,     // за 1 минуту (60 сек)
      greenColor: '#16a34a',   // зелёный цвет
      yellowColor: '#eab308',  // жёлтый цвет
      redColor: '#dc2626'      // красный цвет
    }
  };
  rooms.set(pin, room);
  saveState();
  return room;
}

function getCurrentRemainingMs(room) {
  if (room.status === 'running' && room.endTimeMs !== null) {
    return room.endTimeMs - Date.now();
  }
  return room.remainingMs;
}

function serializeRoom(room) {
  return {
    ...room,
    remainingMs: getCurrentRemainingMs(room),
    serverNow: Date.now(),
    lanOrigin: LAN_ORIGIN
  };
}

function broadcastRoom(pin) {
  const room = rooms.get(pin);
  if (!room) return;
  const roomClients = clients.get(pin);
  if (!roomClients || roomClients.size === 0) return;

  const payload = `data: ${JSON.stringify(serializeRoom(room))}\n\n`;
  for (const res of roomClients) {
    try {
      res.write(payload);
    } catch (e) {
      roomClients.delete(res);
    }
  }
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;

  // Healthcheck для облачных платформ, Docker и мониторинга
  if (pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.floor(process.uptime())
    });
    return;
  }

  // Главная страница — редирект на админку пульта
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(302, { Location: '/control' });
    res.end();
    return;
  }

  // Экран сцены (/stage)
  if (pathname === '/stage' && req.method === 'GET') {
    serveStaticFile(res, path.join(__dirname, 'public', 'stage.html'), 'text/html; charset=utf-8');
    return;
  }

  // Пульт организатора (/control)
  if (pathname === '/control' && req.method === 'GET') {
    serveStaticFile(res, path.join(__dirname, 'public', 'control.html'), 'text/html; charset=utf-8');
    return;
  }

  // Создание новой комнаты/пульта (случайный PIN или восстановление по заданному PIN)
  if (pathname === '/api/create-room' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = body.trim() ? JSON.parse(body) : {};
        const requestedPin = data.pin ? String(data.pin).trim() : null;
        const room = createRoom(requestedPin);
        sendJson(res, 200, serializeRoom(room));
      } catch (err) {
        const status = err.message && err.message.includes('4 цифр') ? 400 : 500;
        sendJson(res, status, { error: err.message || 'Ошибка создания пульта' });
      }
    });
    return;
  }

  // Проверка существования пульта по PIN
  if (pathname === '/api/room-exists' && req.method === 'GET') {
    const pin = String(searchParams.get('pin') || '').trim();
    if (pin && rooms.has(pin)) {
      sendJson(res, 200, { ok: true, pin, lanOrigin: LAN_ORIGIN });
    } else {
      sendJson(res, 404, { ok: false, error: 'Пульт с таким PIN не найден' });
    }
    return;
  }

  // Генерация SVG QR-кода для ссылки на /stage?pin=XXXX
  if (pathname === '/api/qr' && req.method === 'GET') {
    const targetUrl = String(searchParams.get('url') || '').trim();
    if (!targetUrl) {
      sendJson(res, 400, { error: 'Параметр url обязателен' });
      return;
    }
    try {
      const svg = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        width: 240
      });
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(svg);
    } catch (err) {
      sendJson(res, 500, { error: 'Ошибка генерации QR-кода' });
    }
    return;
  }

  // SSE поток для синхронизации в реальном времени (/api/events?pin=XXXX)
  if (pathname === '/api/events' && req.method === 'GET') {
    const pin = String(searchParams.get('pin') || '').trim();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let room = rooms.get(pin);
    if (!room) {
      if (/^\d{4}$/.test(pin)) {
        room = createRoom(pin);
      } else {
        res.write(`data: ${JSON.stringify({ error: 'not_found' })}\n\n`);
        res.end();
        return;
      }
    }

    if (!clients.has(pin)) {
      clients.set(pin, new Set());
    }
    clients.get(pin).add(res);

    // Сразу отправляем актуальное состояние при подключении/переподключении
    res.write(`data: ${JSON.stringify(serializeRoom(room))}\n\n`);

    req.on('close', () => {
      const set = clients.get(pin);
      if (set) set.delete(res);
    });
    return;
  }

  // Управление комнатой (/api/action)
  if (pathname === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const pin = String(data.pin || '').trim();
        const room = rooms.get(pin);

        if (!room) {
          sendJson(res, 404, { error: 'Комната не найдена' });
          return;
        }

        const action = data.action;
        const now = Date.now();

        switch (action) {
          case 'set_duration': {
            const sec = Math.max(1, Math.min(36000, Number(data.seconds) || 600));
            room.durationSec = sec;
            room.status = 'idle';
            room.remainingMs = sec * 1000;
            room.endTimeMs = null;
            break;
          }

          case 'start': {
            if (room.status !== 'running') {
              const startMs = room.remainingMs;
              room.status = 'running';
              room.endTimeMs = now + startMs;
            }
            break;
          }

          case 'pause': {
            if (room.status === 'running') {
              room.remainingMs = room.endTimeMs - now;
              room.endTimeMs = null;
              room.status = 'paused';
            }
            break;
          }

          case 'reset': {
            room.status = 'idle';
            room.remainingMs = room.durationSec * 1000;
            room.endTimeMs = null;
            break;
          }

          case 'adjust': {
            const deltaMs = (Number(data.deltaSec) || 0) * 1000;
            if (room.status === 'running') {
              room.endTimeMs += deltaMs;
            } else {
              room.remainingMs += deltaMs;
            }
            break;
          }

          case 'message': {
            if (typeof data.message === 'string') {
              room.message = data.message.trim().slice(0, 200);
            }
            if (typeof data.show === 'boolean') {
              room.showMessage = data.show && room.message.length > 0;
            }
            break;
          }

          case 'settings': {
            const s = data.settings || {};
            if (typeof s.blackBackground === 'boolean') {
              room.settings.blackBackground = s.blackBackground;
            }
            if (s.yellowThresholdSec !== undefined) {
              room.settings.yellowThresholdSec = Math.max(0, Number(s.yellowThresholdSec) || 0);
            }
            if (s.redThresholdSec !== undefined) {
              room.settings.redThresholdSec = Math.max(0, Number(s.redThresholdSec) || 0);
            }
            if (typeof s.greenColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.greenColor)) {
              room.settings.greenColor = s.greenColor;
            }
            if (typeof s.yellowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.yellowColor)) {
              room.settings.yellowColor = s.yellowColor;
            }
            if (typeof s.redColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.redColor)) {
              room.settings.redColor = s.redColor;
            }
            break;
          }

          default:
            sendJson(res, 400, { error: 'Unknown action' });
            return;
        }

        saveState();
        broadcastRoom(pin);
        sendJson(res, 200, serializeRoom(room));
      } catch (err) {
        sendJson(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// Периодический keep-alive пинг каждые 15 секунд для поддержания SSE-соединения
// и синхронизации часов клиентов
setInterval(() => {
  for (const pin of clients.keys()) {
    broadcastRoom(pin);
  }
}, 15000);

loadState();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================`);
  console.log(`Stage Timer запущен на порту ${PORT}`);
  console.log(`Пульт (локально):   http://localhost:${PORT}/control`);
  console.log(`Сцена (локально):   http://localhost:${PORT}/stage`);
  if (LAN_ORIGIN) {
    console.log(`Пульт (по Wi-Fi):   ${LAN_ORIGIN}/control`);
    console.log(`Сцена (по Wi-Fi):   ${LAN_ORIGIN}/stage`);
  }
  console.log(`================================================`);
});
