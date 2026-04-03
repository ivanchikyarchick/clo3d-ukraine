/**
 * server.js — OPTIMIZED for 0.1 CPU / 512MB RAM on Render
 *
 * Video storage:
 *   ≤50 MB → Telegram (sendVideo)
 *   >50 MB → Cloudflare R2 (S3-compatible upload)
 */

const express    = require('express');
const session    = require('express-session');
const compression = require('compression');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const http       = require('http');
const multer     = require('multer');
const os         = require('os');
const db         = require('./db');
const r2         = require('./r2');
const { mountMonopayWebhook, mountMonopayApi } = require('./monopay');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CL34tyre';
console.log('[server] Starting with ADMIN_PASSWORD:', ADMIN_PASSWORD);
const PORT           = process.env.PORT || 3000;
const BOT_TOKEN      = process.env.BOT_TOKEN || '8606783327:AAFlvRiAqhxLuxwtx_6l4glNeqlSS4x96AE';
const SITE_URL       = process.env.SITE_URL || 'https://fashionlab.com.ua';
const ADMIN_ID       = parseInt(process.env.ADMIN_ID || '6590778330');
const MONOBANK_TOKEN = process.env.MONOBANK_TOKEN || '';
const ACCESS_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_GRANT_COURSES = (process.env.AUTO_GRANT_COURSES || 'mn1v7bplqru').split(',').map(s => s.trim()).filter(Boolean);

function isAccessExpired(grantedAt) {
  return grantedAt && (Date.now() - grantedAt > ACCESS_EXPIRY_MS);
}

function autoGrantAccess(uid) {
  if (AUTO_GRANT_COURSES.length === 0) return;
  db.set(d => {
    for (const cid of AUTO_GRANT_COURSES) {
      const c = d.courses.find(x => x.id === cid);
      if (c && !c.buyers?.some(b => b.id === uid)) {
        if (!c.buyers) c.buyers = [];
        c.buyers.push({ id: uid, name: '—', grantedAt: Date.now() });
        console.log('[autoGrant] Access granted to user', uid, 'for course:', c.title);
      }
    }
  });
}

function activeBuyerCourses(uid) {
  const d = db.get();
  const courses = d.courses || [];
  const uidNum = parseInt(uid);
  
  const activeCourses = courses.filter(c => c.buyers?.some(b => parseInt(b.id) === uidNum));
  return activeCourses;
}


const app = express();

fs.mkdirSync('/tmp/vfl_tmp', { recursive: true });
const uploadImport   = multer({ dest: '/tmp/vfl_tmp/' });
const uploadVideo    = multer({ dest: '/tmp/vfl_tmp/', limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
const uploadMaterial = multer({ dest: '/tmp/vfl_tmp/', limits: { fileSize: 200 * 1024 * 1024 } });

// Webhook route - handle raw body only for webhook path
const webhookRouter = express.Router();

// Вебхук Monobank (raw JSON) — ДО express.json(), інакше body порожній
mountMonopayWebhook(webhookRouter);

// Mount webhook router before other middleware
app.use('/api', webhookRouter);

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 1: gzip compression — зменшує трафік на 60-80%
// ═══════════════════════════════════════════════════════════
app.use(compression({
  level: 1,
  threshold: 1024,
  filter: (req, res) => {
    if (req.path.startsWith('/api/video/')) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══ Сесії в RAM ═══
app.use(session({
  secret: process.env.SESSION_SECRET || 'vfl_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: null } // сесія закінчується при закритті браузера
}));

// Створення платежу / статус — ПІСЛЯ JSON + session (інакше req.body порожній)
mountMonopayApi(app);

// ═══ Security headers ═══
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/video/')) {
    const ref = req.headers.referer || '', host = req.headers.host || '';
    if (ref && !ref.includes(host)) { res.status(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 2: trackWeb — сэмплінг 1/10 (було 1/5)
// ═══════════════════════════════════════════════════════════
let _webTrackCounter = 0;
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && req.method === 'GET') {
    if (++_webTrackCounter % 10 === 0) {
      db.trackWeb('visit', req.ip, req.path, { ua: (req.headers['user-agent'] || '').slice(0, 50) });
    }
  }
  next();
});

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 3: Request timeout — вбиваємо зависші запити
// ═══════════════════════════════════════════════════════════
app.use((req, res, next) => {
  const timeout = (req.path.includes('/upload') || req.method === 'POST' && (req.path.includes('/videos') || req.path.includes('/materials'))) ? 1200000 : (req.path.includes('/video/') ? 120000 : 30000);
  req.setTimeout(timeout);
  res.setTimeout(timeout);
  next();
});

const adm = (req, res, next) => {
  if (req.session.isAdmin) { req.session.touch(); return next(); }
  const hdr = req.headers['x-admin-password'];
  if (hdr && hdr === ADMIN_PASSWORD) { req.session.isAdmin = true; return next(); }
  res.status(401).json({ ok: false, error: 'Unauthorized' });
};

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 4: Розумний кеш з TTL
// ═══════════════════════════════════════════════════════════
const _responseCache = new Map();
function cachedResponse(key, ttlMs, builder) {
  const cached = _responseCache.get(key);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.data;
  const data = builder();
  _responseCache.set(key, { data, ts: Date.now() });
  return data;
}
function invalidateCache() {
  _responseCache.clear();
}

// Settings
app.get('/api/settings', adm, (_, res) => res.json({ fop: db.get().settings?.fop || '', monoToken: db.get().settings?.monoToken ? '***set***' : '' }));
app.post('/api/settings', adm, (req, res) => {
  const { fop, monoToken } = req.body;
  db.set(d => { 
    if (!d.settings) d.settings = {}; 
    if (fop !== undefined) d.settings.fop = fop; 
    if (monoToken !== undefined) d.settings.monoToken = monoToken;
  });
  invalidateCache();
  res.json({ ok: true });
});
app.get('/api/settings/public', (_, res) => res.json({ fop: db.get().settings?.fop || '' }));

app.post('/api/login', (req, res) => {
  const inputPwd = req.body?.password?.trim() || '';
  const expectedPwd = ADMIN_PASSWORD.trim();
  console.log('[login] Attempt with password:', JSON.stringify(inputPwd));
  console.log('[login] Expected:', JSON.stringify(expectedPwd));
  console.log('[login] Match:', inputPwd === expectedPwd);
  if (inputPwd === expectedPwd) { 
    req.session.isAdmin = true; 
    console.log('[login] SUCCESS');
    res.json({ ok: true }); 
  }
  else { 
    console.log('[login] FAILED');
    res.status(401).json({ ok: false, error: 'Невірний пароль' }); 
  }
});

// Test endpoint
app.post('/api/test', (req, res) => {
  console.log('[test] body:', req.body);
  res.json({ body: req.body });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 5: Dashboard кешується на 60 секунд
// ═══════════════════════════════════════════════════════════
app.get('/api/dashboard', adm, (req, res) => {
  const data = cachedResponse('dashboard', 60000, () => {
    const d = db.get(), s = d.stats || {}, now = Date.now();
    const bEvt = s.botEvents || [], wEvt = s.webEvents || [];
    const dayLabels = [], botByDay = [], webByDay = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now - i * 86400000);
      dayLabels.push(`${day.getDate()}.${day.getMonth() + 1}`);
      const start = new Date(day).setHours(0, 0, 0, 0), end = start + 86400000;
      botByDay.push(bEvt.filter(e => e.ts >= start && e.ts < end).length);
      webByDay.push(wEvt.filter(e => e.ts >= start && e.ts < end).length);
    }
    const cs = d.courses || [], t = s.totals || {}, evTypes = {}, webAccounts = (d.buyerAccounts || []).length;
    bEvt.forEach(e => { evTypes[e.type] = (evTypes[e.type] || 0) + 1; });
    return {
      summary: {
        courses: cs.length,
        buyers: cs.reduce((s, c) => s + (c.buyers?.length || 0), 0),
        webAccounts: webAccounts,
        pending: cs.reduce((s, c) => s + (c.pending?.length || 0), 0),
        videos: cs.reduce((s, c) => s + (c.videos?.length || 0), 0),
        buyRequests: t.buyRequests || 0, videoViews: t.videoViews || 0,
        webVisits7: wEvt.filter(e => now - e.ts < 7 * 86400000).length,
        messages: t.messages || 0, granted: t.granted || 0
      },
      charts: { dayLabels, botByDay, webByDay }, evTypes,
      recentBot: bEvt.slice(-20).reverse(),
      recentWeb: wEvt.slice(-20).reverse(),
      courses: cs,
    };
  });
  res.json(data);
});

// ═══ Public courses (CACHED 30s) ═══
app.get('/api/courses/public', (req, res) => {
  const data = cachedResponse('courses_public', 30000, () =>
    (db.get().courses || []).filter(c => c.published).map(c => ({
      id: c.id, slug: c.slug, title: c.title, description: c.description,
      price: c.price, badge: c.badge, color: c.color || '#5b8dee',
      videoCount: c.videos?.length || 0, freeAccess: !!c.freeAccess
    }))
  );
  res.json(data);
});

app.get('/api/course/:slug/public', (req, res) => {
  const data = cachedResponse('course_' + req.params.slug, 30000, () => {
    const c = (db.get().courses || []).find(x => x.slug === req.params.slug && x.published);
    if (!c) return null;
    return { id: c.id, slug: c.slug, title: c.title, description: c.description, price: c.price, priceAmount: c.priceAmount || c.price, badge: c.badge, color: c.color, videoCount: c.videos?.length || 0, includes: c.includes || [], features: c.features || [], freeAccess: !!c.freeAccess };
  });
  if (!data) { res.status(404).json({ ok: false }); return; }
  res.json(data);
});

// Video lists
const vidList = (v, i) => ({ i, title: v.title, desc: v.desc, hasMaterials: !!(v.materials?.length) });

app.get('/api/course/:cid/videos/public', (req, res) => {
  const c = (db.get().courses || []).find(x => x.id === req.params.cid);
  if (!c) { res.status(404).json({ ok: false }); return; }
  res.json((c.videos || []).map(vidList));
});

app.get('/api/course/:cid/videos/free', (req, res) => {
  const c = (db.get().courses || []).find(x => x.id === req.params.cid && x.freeAccess);
  if (!c) { res.status(403).json({ ok: false }); return; }
  res.json((c.videos || []).map(vidList));
});

// Admin preview
app.post('/api/admin/preview', adm, (req, res) => {
  const courses = (db.get().courses || []).filter(c => c.videos?.length);
  if (!courses.length) { res.status(404).json({ ok: false, error: 'Немає курсів з відео' }); return; }
  req.session.buyerId = 0; req.session.buyerName = 'Адмін'; req.session.isAdminPreview = true;
  res.json({ ok: true, name: 'Адмін', courses: courses.map(c => ({ id: c.id, slug: c.slug, title: c.title, color: c.color })) });
});

// Buyer auth
app.post('/api/buyer/login', (req, res) => {
  const uid = parseInt(req.body.telegramId);
  if (!uid) { res.status(400).json({ ok: false, error: 'Невірний ID' }); return; }
  const myCourses = activeBuyerCourses(uid);
  if (!myCourses.length) { res.status(403).json({ ok: false, error: 'Доступ не знайдено або термін доступу закінчився.' }); return; }
  req.session.buyerId = uid;
  req.session.buyerName = myCourses[0].buyers.find(b => b.id === uid && !isAccessExpired(b.grantedAt))?.name || 'Учень';
  res.json({ ok: true, name: req.session.buyerName, courses: myCourses.map(c => {
    const buyer = c.buyers.find(b => b.id === uid && !isAccessExpired(b.grantedAt));
    return { id: c.id, slug: c.slug, title: c.title, color: c.color, grantedAt: buyer?.grantedAt };
  }) });
});

app.post('/api/buyer/logout', (req, res) => { req.session.buyerId = null; res.json({ ok: true }); });

// Debug endpoint to manually grant access (for testing)
app.post('/api/debug/grant-access', adm, (req, res) => {
  const { buyerId, courseId } = req.body;
  if (!buyerId || !courseId) {
    res.status(400).json({ ok: false, error: 'buyerId and courseId required' });
    return;
  }

  db.set(d => {
    const c = d.courses.find(x => x.id === courseId);
    if (c && !c.buyers?.some(b => b.id === buyerId)) {
      if (!c.buyers) c.buyers = [];
      c.buyers.push({ id: parseInt(buyerId), name: '—', grantedAt: Date.now() });
      console.log('[debug] Access granted to buyer:', buyerId, 'course:', courseId);
      res.json({ ok: true, message: 'Access granted' });
    } else {
      res.json({ ok: false, error: 'Already has access or course not found' });
    }
  });
});

// Grant access to ALL users (all buyerAccounts)
app.post('/api/debug/grant-all', adm, (req, res) => {
  const { courseId } = req.body;
  if (!courseId) {
    res.status(400).json({ ok: false, error: 'courseId required' });
    return;
  }

  db.set(d => {
    const c = d.courses.find(x => x.id === courseId);
    if (!c) { res.json({ ok: false, error: 'Course not found' }); return; }
    if (!c.buyers) c.buyers = [];
    const accounts = d.buyerAccounts || [];
    let added = 0;
    for (const acc of accounts) {
      if (!c.buyers.some(b => b.id === acc.id)) {
        c.buyers.push({ id: acc.id, name: acc.username || '—', grantedAt: Date.now() });
        added++;
      }
    }
    console.log('[debug] Access granted to', added, 'users for course:', courseId);
    res.json({ ok: true, message: `Access granted to ${added} users`, count: added });
  });
});

// Debug endpoint to check database state
app.get('/api/debug/db-state', adm, (req, res) => {
  const d = db.get();
  const result = {
    courses: d.courses?.map(c => ({
      id: c.id,
      title: c.title,
      buyers: c.buyers?.length || 0,
      buyerList: c.buyers?.map(b => ({ id: b.id, grantedAt: b.grantedAt })) || []
    })) || [],
    buyerAccounts: d.buyerAccounts?.length || 0,
    buyerAccountsList: d.buyerAccounts?.map(a => ({ id: a.id, username: a.username, createdAt: a.createdAt })) || [],
    pendingPayments: d.pendingPayments?.length || 0,
    pendingPaymentsList: d.pendingPayments || []
  };
  res.json(result);
});

app.get('/api/buyer/me', (req, res) => {
  if (req.session.isAdminPreview) {
    const courses = (db.get().courses || []).filter(c => c.videos?.length).map(c => ({ id: c.id, slug: c.slug, title: c.title, color: c.color }));
    res.json({ ok: true, name: 'Адмін', courses }); return;
  }
  const uid = req.session.buyerId;
  console.log('[buyer/me] session buyerId:', uid, 'type:', typeof uid, 'buyerName:', req.session.buyerName);
  if (!uid) { res.json({ ok: false }); return; }

  const d = db.get();
  // Check and process pending payments
  const pendingForUser = d.pendingPayments?.filter(p => p.buyerId === parseInt(uid));
  if (pendingForUser?.length) {
    db.set(d => {
      const pending = d.pendingPayments?.filter(p => p.buyerId === parseInt(uid)) || [];
      for (const p of pending) {
        const c = d.courses.find(x => x.id === p.courseId);
        if (c && !c.buyers?.some(b => b.id === parseInt(uid))) {
          if (!c.buyers) c.buyers = [];
          c.buyers.push({ id: parseInt(uid), name: '—', grantedAt: Date.now() });
        }
      }
      d.pendingPayments = (d.pendingPayments || []).filter(p => p.buyerId !== parseInt(uid));
    });
  }

  const myCourses = activeBuyerCourses(uid);
  const uidNum = parseInt(uid, 10);
  res.json({
    ok: true,
    id: uidNum,
    name: req.session.buyerName,
    courses: myCourses.map(c => {
      const buyer = c.buyers.find(b => parseInt(b.id, 10) === uidNum);
      return { id: c.id, slug: c.slug, title: c.title, color: c.color, grantedAt: buyer?.grantedAt };
    }),
  });
});

app.get('/api/debug/buyer/:id', (req, res) => {
  const uid = parseInt(req.params.id);
  const d = db.get();
  const courses = d.courses || [];
  const buyerCourses = courses.filter(c => c.buyers?.some(b => b.id === uid && !isAccessExpired(b.grantedAt)));
  const pending = d.pendingPayments?.filter(p => p.buyerId === uid) || [];
  const account = d.buyerAccounts?.find(a => a.id === uid);
  res.json({ 
    buyerId: uid, 
    account: account ? { id: account.id, username: account.username } : null,
    buyerCourses: buyerCourses.map(c => ({ id: c.id, title: c.title })),
    pendingPayments: pending,
    courseBuyers: courses.map(c => ({ 
      id: c.id, 
      title: c.title, 
      buyers: c.buyers?.map(b => ({ id: b.id, grantedAt: b.grantedAt, expired: isAccessExpired(b.grantedAt) }))
    }))
  });
});
const _buyerUsers = new Map();
function hashPassword(pwd) { return 'x:' + pwd.split('').reverse().join(''); }
function verifyPassword(pwd, hash) { return hashPassword(pwd) === hash; }

app.post('/api/buyer/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || username.trim().length < 3) { res.status(400).json({ ok: false, error: 'Юзернейм мінімум 3 символи' }); return; }
  if (!password || password.length < 4) { res.status(400).json({ ok: false, error: 'Пароль мінімум 4 символи' }); return; }
  const nameClean = username.trim().slice(0, 30).toLowerCase();
  console.log('[register] username:', nameClean, 'hash:', hashPassword(password));
  const d = db.get();
  let buyer = _buyerUsers.get(nameClean);
  if (buyer) { res.status(400).json({ ok: false, error: 'Такий юзернейм вже є' }); return; }
  const newUid = Date.now();
  const newHash = hashPassword(password);
  _buyerUsers.set(nameClean, { id: newUid, password: newHash });
  db.set(d => {
    if (!d.buyerAccounts) d.buyerAccounts = [];
    d.buyerAccounts.push({ id: newUid, username: nameClean, password: newHash, createdAt: Date.now() });
    console.log('[register] Added buyer account:', newUid, nameClean, 'total accounts:', d.buyerAccounts.length);
  });
  // Force immediate save to ensure data is available across restarts
  db.flushSync();
  req.session.buyerId = newUid;
  req.session.buyerName = nameClean;
  console.log('[register] Session set for buyer:', newUid, nameClean);
  autoGrantAccess(newUid);
  res.json({ ok: true, id: newUid, name: nameClean });
});

app.post('/api/buyer/login-web', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) { res.status(400).json({ ok: false, error: 'Введіть юзернейм та пароль' }); return; }
  const nameClean = username.trim().slice(0, 30).toLowerCase();
  console.log('[login-web] attempting:', nameClean, 'pwd hash:', hashPassword(password));
  let buyer = _buyerUsers.get(nameClean);
  if (!buyer) {
    const d = db.get();
    console.log('[login-web] checking db.buyerAccounts:', d.buyerAccounts?.length, 'accounts');
    // Case-insensitive search
    const acc = d.buyerAccounts?.find(a => a.username?.toLowerCase() === nameClean);
    if (acc) { buyer = acc; _buyerUsers.set(nameClean, acc); console.log('[login-web] found in db:', acc.id, acc.username); }
  }
  if (!buyer) { console.log('[login-web] buyer not found'); res.status(401).json({ ok: false, error: 'Невірний юзернейм або пароль' }); return; }
  const pwdMatch = verifyPassword(password, buyer.password);
  console.log('[login-web] pwd match:', pwdMatch, 'input hash:', hashPassword(password), 'stored hash:', buyer.password);
  if (!pwdMatch) { res.status(401).json({ ok: false, error: 'Невірний юзернейм або пароль' }); return; }
  req.session.buyerId = buyer.id;
  req.session.buyerName = nameClean;
  console.log('[login-web] Session set for buyer:', buyer.id, nameClean);
  autoGrantAccess(buyer.id);
  res.json({ ok: true, id: buyer.id, name: nameClean });
});


const _tgFileCache = new Map();
const TG_FILE_CACHE_TTL = 50 * 60 * 1000;

async function getTgFileUrl(fileId) {
  const cached = _tgFileCache.get(fileId);
  if (cached && Date.now() - cached.ts < TG_FILE_CACHE_TTL) return cached;
  const info = await fetchJson(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  if (!info.ok) { console.error('[getFile] fail:', info.description || 'unknown'); throw new Error('Telegram getFile: ' + (info.description || 'error')); }
  const result = {
    url: `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`,
    size: info.result.file_size || 0,
    ts: Date.now()
  };
  _tgFileCache.set(fileId, result);
  if (_tgFileCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of _tgFileCache) {
      if (now - v.ts > TG_FILE_CACHE_TTL) _tgFileCache.delete(k);
    }
  }
  return result;
}

// Video streaming
app.get('/api/video/free/:cid/:idx', (req, res) => {
  const c = (db.get().courses || []).find(x => x.id === req.params.cid);
  if (!c || !c.freeAccess) { res.status(403).end(); return; }
  const v = c.videos?.[parseInt(req.params.idx)];
  if (!v) { res.status(404).end(); return; }
  streamVideo(v, req, res);
});

app.get('/api/video/stream/:cid/:idx', (req, res) => {
  const isAdm = req.session.isAdmin || req.session.isAdminPreview;
  if (!isAdm) {
    const uid = req.session.buyerId;
    if (!uid) { res.status(403).end(); return; }
    const c = db.get().courses.find(x => x.id === req.params.cid);
    const buyer = c?.buyers?.find(b => b.id === uid);
    if (!buyer || isAccessExpired(buyer.grantedAt)) { res.status(403).end(); return; }
  }
  const c = db.get().courses.find(x => x.id === req.params.cid);
  const v = c?.videos?.[parseInt(req.params.idx)];
  if (!v) { res.status(404).end(); return; }
  streamVideo(v, req, res);
});

async function streamVideo(video, req, res) {
  // ═══ Cloudflare R2 ═══
  if (video.r2Key) {
    console.log(`[stream] R2: ${video.r2Key} (${video.size} bytes)`);
    try {
      await r2.streamFile(video.r2Key, video.size || 0, req, res);
    } catch (e) {
      console.error('[stream] R2 error:', e.message);
      if (!res.headersSent) res.status(500).end(e.message);
    }
    return;
  }
  // ═══ Одиночний файл в Telegram ═══
  if (video.telegramFileId) {
    streamTg(video.telegramFileId, req, res);
    return;
  }
  res.status(404).end('Відео не знайдено');
}

async function streamTg(fileId, req, res) {
  try {
    const file = await getTgFileUrl(fileId);
    const fSize = file.size;
    const url = file.url;
    const range = req.headers.range;

    if (range && fSize) {
      const [s, e0] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(s), end = e0 ? parseInt(e0) : Math.min(start + 2 * 1024 * 1024, fSize - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'inline'
      });
      proxyStream(url, res, { Range: `bytes=${start}-${end}` });
    } else {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
        ...(fSize ? { 'Content-Length': fSize } : {})
      });
      proxyStream(url, res);
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).end(e.message);
  }
}

function fetchJson(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(15000, () => { req.destroy(); rej(new Error('fetchJson timeout')); });
  });
}

function proxyStream(url, res, h = {}) {
  const mod = url.startsWith('https') ? https : http;
  console.log(`[proxy] → ${url.slice(0, 80)}...`);
  const req = mod.get(url, { headers: h }, up => {
    // Тільки безпечні заголовки (Telegram повертає transfer-encoding/content-encoding які ламають)
    const outH = { 'Content-Type': up.headers['content-type'] || 'application/octet-stream' };
    if (up.headers['content-length']) outH['Content-Length'] = up.headers['content-length'];
    if (!res.headersSent) res.writeHead(up.statusCode || 200, outH);
    up.pipe(res);
    up.on('end', () => console.log('[proxy] done'));
    up.on('error', (e) => { console.error('[proxy] up error:', e.message); if (!res.writableEnded) res.end(); });
  });
  req.on('error', (e) => { console.error('[proxy] req error:', e.message); if (!res.headersSent) res.status(502).end(); else if (!res.writableEnded) res.end(); });
  req.setTimeout(60000, () => { console.error('[proxy] timeout'); req.destroy(); if (!res.writableEnded) res.end(); });
  res.on('close', () => { console.log('[proxy] client closed'); req.destroy(); });
}

// Admin courses CRUD
app.get('/api/courses', adm, (req, res) => res.json(db.get().courses || []));

app.post('/api/courses', adm, (req, res) => {
  const { title, description, price, priceAmount, badge, color, published, includes, features, freeAccess } = req.body;
  if (!title) { res.status(400).json({ ok: false, error: 'Потрібна назва' }); return; }
  const id = db.newId(), slug = db.slugify(title);
  db.set(d => { d.courses.push({ id, slug, title, description: description || '', price: price || '', priceAmount: priceAmount || price || '', badge: badge || '', color: color || '#C8302A', published: !!published, freeAccess: !!freeAccess, createdAt: Date.now(), videos: [], buyers: [], pending: [], includes: includes || [], features: features || [] }); });
  invalidateCache();
  res.json({ ok: true, id, slug });
});

app.patch('/api/courses/:id', adm, (req, res) => {
  db.set(d => {
    const c = d.courses.find(x => x.id === req.params.id); if (!c) return;
    const { title, description, price, priceAmount, badge, color, published, includes, features, freeAccess } = req.body;
    if (title !== undefined) { c.title = title; c.slug = db.slugify(title); }
    if (description !== undefined) c.description = description; if (price !== undefined) c.price = price; if (priceAmount !== undefined) c.priceAmount = priceAmount;
    if (badge !== undefined) c.badge = badge; if (color !== undefined) c.color = color;
    if (published !== undefined) c.published = !!published; if (includes !== undefined) c.includes = includes;
    if (features !== undefined) c.features = features; if (freeAccess !== undefined) c.freeAccess = !!freeAccess;
  });
  invalidateCache();
  res.json({ ok: true });
});

app.delete('/api/courses/:id', adm, (req, res) => { db.set(d => { d.courses = d.courses.filter(c => c.id !== req.params.id); }); invalidateCache(); res.json({ ok: true }); });

// Video upload
function checkAdm(req, res) {
  if (req.session.isAdmin) return true;
  if (req.headers['x-admin-password'] === ADMIN_PASSWORD) { req.session.isAdmin = true; return true; }
  if (req.file) try { fs.unlinkSync(req.file.path); } catch { }
  res.status(401).json({ ok: false, error: 'Unauthorized' }); return false;
}

function postForm(ep, form) {
  return new Promise((res, rej) => {
    let settled = false;
    const done = (err, val) => { if (settled) return; settled = true; err ? rej(err) : res(val); };
    const h = form.getHeaders();
    const r = https.request({ hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}${ep}`, method: 'POST', headers: h }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { done(null, JSON.parse(d)); } catch (e) { done(e); } });
    });
    r.on('error', (e) => done(e));
    r.setTimeout(120000, () => { r.destroy(); done(new Error('Telegram timeout')); });
    form.on('error', (e) => { r.destroy(); done(e); });
    form.pipe(r);
  });
}

app.post('/api/courses/:cid/videos', uploadVideo.single('video'), async (req, res) => {
  if (!checkAdm(req, res)) return;
  if (!req.file) { res.status(400).json({ ok: false, error: 'Немає файлу' }); return; }
  const cid = req.params.cid;
  const title = req.body.title || `Урок ${(db.getCourse(cid)?.videos?.length || 0) + 1}`;
  const desc = req.body.desc || '';
  const size = req.file.size || 0;
  const TG_MAX = 50 * 1024 * 1024;

  try {
    let videoEntry;

    if (size <= TG_MAX) {
      // ═══ Файл ≤ 50 МБ → sendVideo в Telegram (стандартний потік) ═══
      const FormData = require('form-data'), form = new FormData();
      form.append('chat_id', ADMIN_ID);
      form.append('caption', `${title}\n\n${desc}`);
      form.append('protect_content', 'true');
      form.append('video', fs.createReadStream(req.file.path), { filename: req.file.originalname || 'video.mp4', contentType: req.file.mimetype || 'video/mp4' });
      const tgRes = await postForm('/sendVideo', form);
      try { fs.unlinkSync(req.file.path); } catch { }
      if (!tgRes.ok) { res.status(500).json({ ok: false, error: tgRes.description || 'Telegram error' }); return; }
      videoEntry = {
        id: db.newId(), title, desc,
        telegramFileId: tgRes.result.video.file_id,
        size: tgRes.result.video.file_size || size,
        addedAt: Date.now()
      };
    } else {
      // ═══ Файл > 50 МБ → Cloudflare R2 ═══
      if (!r2.configured) {
        try { fs.unlinkSync(req.file.path); } catch { }
        res.status(400).json({ ok: false, error: 'R2 не налаштований. Додайте R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET у змінні середовища.' });
        return;
      }
      const r2key = r2.makeKey(cid, req.file.originalname);
      const mime = req.file.mimetype || 'video/mp4';
      await r2.uploadFile(r2key, req.file.path, mime, size);
      try { fs.unlinkSync(req.file.path); } catch { }
      videoEntry = {
        id: db.newId(), title, desc,
        r2Key: r2key,
        size,
        addedAt: Date.now()
      };
    }

    console.log(`[upload] saved: "${videoEntry.title}" (${(size/1024/1024).toFixed(1)}MB) r2=${!!videoEntry.r2Key} tg=${!!videoEntry.telegramFileId}`);
    db.set(d => { const c = d.courses.find(x => x.id === cid); if (c) { if (!c.videos) c.videos = []; c.videos.push(videoEntry); } });
    invalidateCache();
    res.json({ ok: true, total: db.getCourse(cid)?.videos?.length });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch { }
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch('/api/courses/:cid/videos/:idx', adm, (req, res) => {
  db.set(d => { const c = d.courses.find(x => x.id === req.params.cid); const v = c?.videos?.[parseInt(req.params.idx)]; if (v) { if (req.body.title !== undefined) v.title = req.body.title; if (req.body.desc !== undefined) v.desc = req.body.desc; } });
  invalidateCache();
  res.json({ ok: true });
});

app.delete('/api/courses/:cid/videos/:idx', adm, (req, res) => {
  db.set(d => { const c = d.courses.find(x => x.id === req.params.cid); if (c) c.videos.splice(parseInt(req.params.idx), 1); });
  invalidateCache();
  res.json({ ok: true });
});

app.post('/api/courses/:cid/videos/reorder', adm, (req, res) => {
  const { from, to } = req.body;
  db.set(d => { const c = d.courses.find(x => x.id === req.params.cid); if (c) { const [item] = c.videos.splice(from, 1); c.videos.splice(to, 0, item); } });
  invalidateCache();
  res.json({ ok: true });
});

// Material files
app.post('/api/courses/:cid/videos/:idx/materials', uploadMaterial.single('file'), async (req, res) => {
  if (!checkAdm(req, res)) return;
  if (!req.file) { res.status(400).json({ ok: false, error: 'Немає файлу' }); return; }
  const size = req.file.size || 0;
  const TG_FILE_MAX = 20 * 1024 * 1024; // getFile працює лише до 20 МБ

  try {
    let matEntry;

    if (size <= TG_FILE_MAX) {
      // ≤20 МБ → Telegram
      const FormData = require('form-data'), form = new FormData();
      form.append('chat_id', ADMIN_ID);
      form.append('caption', `Матеріали: ${req.file.originalname || 'material'}`);
      form.append('document', fs.createReadStream(req.file.path), { filename: req.file.originalname || 'material', contentType: req.file.mimetype || 'application/octet-stream' });
      const tgRes = await postForm('/sendDocument', form);
      try { fs.unlinkSync(req.file.path); } catch { }
      if (!tgRes.ok) { res.status(500).json({ ok: false, error: tgRes.description || 'Telegram error' }); return; }
      matEntry = { id: db.newId(), name: req.file.originalname, telegramFileId: tgRes.result.document.file_id, size: tgRes.result.document.file_size || size, addedAt: Date.now() };
    } else {
      // >20 МБ → R2
      if (!r2.configured) {
        try { fs.unlinkSync(req.file.path); } catch { }
        res.status(400).json({ ok: false, error: 'Файл >20 МБ потребує R2 (не налаштований)' });
        return;
      }
      const r2key = r2.makeKey(req.params.cid, req.file.originalname);
      await r2.uploadFile(r2key, req.file.path, req.file.mimetype || 'application/octet-stream', size);
      try { fs.unlinkSync(req.file.path); } catch { }
      matEntry = { id: db.newId(), name: req.file.originalname, r2Key: r2key, size, addedAt: Date.now() };
    }

    const cid = req.params.cid, idx = parseInt(req.params.idx);
    db.set(d => { const c = d.courses.find(x => x.id === cid); const v = c?.videos?.[idx]; if (v) { if (!v.materials) v.materials = []; v.materials.push(matEntry); } });
    res.json({ ok: true });
  } catch (e) { try { fs.unlinkSync(req.file.path); } catch { } res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/courses/:cid/videos/:idx/materials/:mid', adm, (req, res) => {
  db.set(d => { const c = d.courses.find(x => x.id === req.params.cid); const v = c?.videos?.[parseInt(req.params.idx)]; if (v) v.materials = (v.materials || []).filter(m => m.id !== req.params.mid); });
  res.json({ ok: true });
});

app.get('/api/course/:cid/videos/:idx/materials', (req, res) => {
  const c = (db.get().courses || []).find(x => x.id === req.params.cid);
  if (!c) { res.status(404).json({ ok: false }); return; }
  const uid = req.session.buyerId, isAdm = req.session.isAdmin || req.session.isAdminPreview;
  const buyer = c.buyers?.find(b => b.id === uid);
  if (!isAdm && !buyer && !c.freeAccess) { res.status(403).json({ ok: false }); return; }
  if (!isAdm && buyer && isAccessExpired(buyer.grantedAt)) { res.status(403).json({ ok: false, error: 'Термін доступу закінчився' }); return; }
  res.json((c.videos?.[parseInt(req.params.idx)]?.materials || []).map(m => ({ id: m.id, name: m.name, size: m.size })));
});

app.get('/api/course/:cid/videos/:idx/materials/:mid/download', async (req, res) => {
  const c = (db.get().courses || []).find(x => x.id === req.params.cid);
  if (!c) { res.status(404).end(); return; }
  const uid = req.session.buyerId, isAdm = req.session.isAdmin || req.session.isAdminPreview;
  const buyer = c.buyers?.find(b => b.id === uid);
  if (!isAdm && !buyer && !c.freeAccess) { res.status(403).end(); return; }
  if (!isAdm && buyer && isAccessExpired(buyer.grantedAt)) { res.status(403).end(); return; }
  const mat = (c.videos?.[parseInt(req.params.idx)]?.materials || []).find(m => m.id === req.params.mid);
  if (!mat) { res.status(404).end(); return; }

  // R2 сховище
  if (mat.r2Key) {
    try {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(mat.name)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      await r2.streamFile(mat.r2Key, mat.size || 0, req, res);
    } catch (e) {
      console.error('[mat-dl] R2 error:', e.message);
      if (!res.headersSent) res.status(500).end(e.message);
    }
    return;
  }

  // Telegram
  console.log(`[mat-dl] TG: ${mat.name}`);
  getTgFileUrl(mat.telegramFileId)
    .then(file => {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(mat.name)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      proxyStream(file.url, res);
    }).catch(e => {
      console.error('[mat-dl] TG error:', e.message);
      if (!res.headersSent) res.status(500).end(e.message);
    });
});

// Progress
app.get('/api/progress/:cid', (req, res) => {
  if (req.session.isAdminPreview) { res.json({ ok: true, watched: [], lastIdx: 0, completed: false }); return; }
  const uid = req.session.buyerId || (req.session.isAdmin ? -1 : null);
  if (!uid) { res.status(403).json({ ok: false }); return; }
  res.json({ ok: true, ...db.getProgress(uid, req.params.cid) });
});

app.post('/api/progress/:cid/:idx', (req, res) => {
  if (req.session.isAdminPreview) { res.json({ ok: true, watched: [], lastIdx: 0, completed: false }); return; }
  const uid = req.session.buyerId;
  if (!uid) { res.status(403).json({ ok: false }); return; }
  const cid = req.params.cid;
  const c = db.get().courses.find(c => c.id === cid);
  const buyer = c?.buyers?.find(b => b.id === uid);
  if (!buyer || isAccessExpired(buyer.grantedAt)) { res.status(403).json({ ok: false }); return; }
  res.json({ ok: true, ...db.markWatched(uid, cid, parseInt(req.params.idx)) });
});

app.get('/api/progress/all/:cid', adm, (req, res) => {
  const c = db.getCourse(req.params.cid);
  if (!c) { res.status(404).json({ ok: false }); return; }
  res.json((c.buyers || []).map(b => {
    const p = db.getProgress(b.id, req.params.cid);
    const pct = c.videos?.length ? Math.round(p.watched.length / c.videos.length * 100) : 0;
    return { id: b.id, name: b.name, username: b.username, watched: p.watched.length, total: c.videos?.length || 0, pct, completed: p.completed, lastTs: p.lastTs };
  }));
});

// Notifications (lazy-load bot)
app.post('/api/notify/new-video/:cid', adm, async (req, res) => {
  const c = db.getCourse(req.params.cid);
  if (!c) { res.status(404).json({ ok: false, error: 'Курс не знайдено' }); return; }
  try {
    const { notifyNewContent } = require('./bot');
    const lastVid = c.videos?.[c.videos.length - 1];
    const text = req.body.text || `Новий урок у «${c.title}»!\n\n${lastVid ? `${lastVid.title}\n\n` : ''}Повернись та продовж навчання: /start`;
    res.json({ ok: true, ...await notifyNewContent(req.params.cid, text) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/notify/remind/:cid', adm, async (req, res) => {
  try { await require('./bot').sendReminders(req.params.cid); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Buyers management
app.post('/api/courses/:cid/grant/:uid', adm, (req, res) => {
  const uid = parseInt(req.params.uid), cid = req.params.cid;
  db.set(d => { const c = d.courses.find(x => x.id === cid); if (!c) return; if (!c.buyers) c.buyers = []; if (!c.buyers.some(b => b.id === uid)) { const p = c.pending?.find(b => b.id === uid); c.buyers.push({ id: uid, name: p?.name || '—', username: p?.username || '', grantedAt: Date.now() }); } c.pending = (c.pending || []).filter(b => b.id !== uid); });
  try { require('./bot').grantAccess(uid, '', '', cid); } catch { }
  invalidateCache();
  res.json({ ok: true });
});

app.post('/api/courses/:cid/revoke/:uid', adm, (req, res) => {
  const uid = parseInt(req.params.uid);
  db.set(d => { const c = d.courses.find(x => x.id === req.params.cid); if (c) c.buyers = (c.buyers || []).filter(b => b.id !== uid); });
  try { require('./bot').bot.sendMessage(uid, 'Ваш доступ відкликано.'); } catch { }
  invalidateCache();
  res.json({ ok: true });
});

app.delete('/api/courses/:cid/pending/:uid', adm, (req, res) => {
  const uid = parseInt(req.params.uid);
  db.set(d => { const c = d.courses.find(x => x.id === req.params.cid); if (c) c.pending = (c.pending || []).filter(b => b.id !== uid); });
  try { require('./bot').bot.sendMessage(uid, 'Ваш запит відхилено.'); } catch { }
  res.json({ ok: true });
});

app.get('/api/courses/:cid/pending/:uid/receipt', adm, async (req, res) => {
  const c = db.get().courses.find(x => x.id === req.params.cid);
  const p = c?.pending?.find(b => b.id === parseInt(req.params.uid));
  if (!p?.receiptFileId) { res.status(404).json({ ok: false, error: 'Квитанція не знайдена' }); return; }
  try {
    const file = await getTgFileUrl(p.receiptFileId);
    const mod = file.url.startsWith('https') ? https : http;
    res.setHeader('Content-Disposition', `attachment; filename="receipt_${req.params.uid}.jpg"`);
    res.setHeader('Content-Type', 'image/jpeg');
    const r = mod.get(file.url, up => { up.pipe(res); });
    r.on('error', () => { if (!res.headersSent) res.status(502).end(); });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/individual/requests', adm, (req, res) => {
  const requests = db.get().individualRequests || [];
  res.json({ ok: true, requests });
});

app.get('/api/individual/requests/:uid/receipt', adm, async (req, res) => {
  const r = db.get().individualRequests?.find(x => x.id === parseInt(req.params.uid));
  if (!r?.receiptFileId) { res.status(404).json({ ok: false, error: 'Квитанція не знайдена' }); return; }
  try {
    const file = await getTgFileUrl(r.receiptFileId);
    const mod = file.url.startsWith('https') ? https : http;
    res.setHeader('Content-Disposition', `attachment; filename="receipt_individual_${req.params.uid}.jpg"`);
    res.setHeader('Content-Type', 'image/jpeg');
    const rq = mod.get(file.url, up => { up.pipe(res); });
    rq.on('error', () => { if (!res.headersSent) res.status(502).end(); });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/individual/confirm/:uid', adm, (req, res) => {
  const uid = parseInt(req.params.uid);
  db.set(d => {
    if (!d.individualRequests) return;
    const r = d.individualRequests.find(x => x.id === uid);
    if (r) r.status = 'granted';
  });
  try { require('./bot').bot.sendMessage(uid, '🎉 Ваш індивідуальний розбір підтверджено! Очікуйте на зв\'язок для узгодження часу.'); } catch { }
  res.json({ ok: true });
});

app.post('/api/individual/reject/:uid', adm, (req, res) => {
  const uid = parseInt(req.params.uid);
  db.set(d => {
    if (!d.individualRequests) return;
    d.individualRequests = d.individualRequests.filter(x => x.id !== uid);
  });
  try { require('./bot').bot.sendMessage(uid, 'На жаль, вашу заявку на індивідуальний розбір відхилено.'); } catch { }
  res.json({ ok: true });
});

// Delete buyer account
app.delete('/api/buyer-accounts/:id', adm, (req, res) => {
  const id = parseInt(req.params.id);
  db.set(d => {
    if (d.buyerAccounts) d.buyerAccounts = d.buyerAccounts.filter(a => a.id !== id);
    // Also revoke from all courses
    d.courses.forEach(c => {
      if (c.buyers) c.buyers = c.buyers.filter(b => b.id !== id);
    });
  });
  invalidateCache();
  res.json({ ok: true });
});

// Broadcast
app.post('/api/broadcast', adm, async (req, res) => {
  const { message, cid } = req.body;
  if (!message) { res.status(400).json({ ok: false, error: 'Немає тексту' }); return; }
  try { res.json({ ok: true, ...await require('./bot').doBroadcast(message, cid || null) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Export/Import
app.get('/api/export/zip', adm, (req, res) => {
  const archiver = require('archiver');
  res.setHeader('Content-Disposition', 'attachment; filename="fashionlab_backup.zip"');
  res.setHeader('Content-Type', 'application/zip');
  const arc = archiver('zip', { zlib: { level: 1 } });
  arc.on('error', e => res.status(500).end(e.message));
  arc.pipe(res);
  arc.file('data/db.json', { name: 'db.json' });
  const d = db.get();
  let bCsv = 'course,id,name,username,grantedAt\n', vCsv = 'course,index,title,desc,storage,fileId,size,addedAt\n';
  (d.courses || []).forEach(c => {
    (c.buyers || []).forEach(b => bCsv += `"${c.title}",${b.id},"${b.name}","${b.username || ''}","${new Date(b.grantedAt).toISOString()}"\n`);
    (c.videos || []).forEach((v, i) => vCsv += `"${c.title}",${i + 1},"${v.title || ''}","${(v.desc || '').replace(/"/g, "'")}","${v.r2Key ? 'r2' : 'telegram'}","${v.telegramFileId || v.r2Key || ''}",${v.size || 0},"${new Date(v.addedAt).toISOString()}"\n`);
  });
  arc.append(bCsv, { name: 'buyers.csv' }); arc.append(vCsv, { name: 'videos.csv' }); arc.finalize();
});

app.get('/api/export/json', adm, (req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="fashionlab_db.json"'); res.json(db.get()); });

app.get('/api/export/stats', adm, (req, res) => {
  const { stats } = db.get();
  const all = [...(stats.botEvents || []), ...(stats.webEvents || [])].sort((a, b) => a.ts - b.ts);
  const csv = 'timestamp,source,type,user,path\n' + all.map(e => `"${new Date(e.ts).toISOString()}","${e.userId ? 'bot' : 'web'}","${e.type}","${e.userId || e.ip || ''}","${e.path || ''}"`).join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="fashionlab_stats.csv"');
  res.setHeader('Content-Type', 'text/csv'); res.send(csv);
});

app.post('/api/import', adm, uploadImport.single('file'), (req, res) => {
  if (!req.file) { res.status(400).json({ ok: false, error: 'Немає файлу' }); return; }
  try {
    const imp = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
    db.set(d => { if (imp.courses) for (const c of imp.courses) if (!d.courses.find(x => x.id === c.id)) d.courses.push(c); });
    fs.unlinkSync(req.file.path);
    invalidateCache();
    res.json({ ok: true, imported: { courses: imp.courses?.length || 0 } });
  } catch (e) { try { fs.unlinkSync(req.file.path); } catch { } res.status(400).json({ ok: false, error: e.message }); }
});

// ── AUTO-SYNC (db.json → Telegram) ───────────────────────────────────────────
const SYNC_STATE_KEY = '__syncMsgId';
let syncEnabled = false;
let syncDebounce = null;
let lastSyncHash = '';

function dbJsonBuffer() { return Buffer.from(JSON.stringify(db.get(), null, 2), 'utf8'); }
function simpleHash(buf) { let h = 5381; for (const b of buf) h = ((h << 5) + h) ^ b; return (h >>> 0).toString(36); }

function tgApiJson(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/${method}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

async function pinMessage(msgId) { try { await tgApiJson('pinChatMessage', { chat_id: ADMIN_ID, message_id: msgId, disable_notification: true }); } catch { } }
async function unpinMessage(msgId) { if (!msgId) return; try { await tgApiJson('unpinChatMessage', { chat_id: ADMIN_ID, message_id: msgId }); } catch { } }

async function sendDbToAdmin(reason) {
  const buf = dbJsonBuffer();
  const hash = simpleHash(buf);
  if (hash === lastSyncHash && reason !== 'startup' && reason !== 'manual') return;
  lastSyncHash = hash;

  const oldMsgId = db.get().settings?.[SYNC_STATE_KEY];
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', ADMIN_ID);
    const ts = new Date().toLocaleString('uk', { timeZone: 'Europe/Kyiv' });
    form.append('caption', `🗄 *db.json* — резервна копія\n📅 ${ts}\n📝 ${reason}`);
    form.append('parse_mode', 'Markdown');
    form.append('document', buf, { filename: 'db.json', contentType: 'application/json' });
    const tgRes = await postForm('/sendDocument', form);

    if (tgRes.ok) {
      const newMsgId = tgRes.result.message_id;
      if (oldMsgId && oldMsgId !== newMsgId) await unpinMessage(oldMsgId);
      await pinMessage(newMsgId);
      const d = db.get(); if (!d.settings) d.settings = {}; d.settings[SYNC_STATE_KEY] = newMsgId;
      if (db.flushSync) db.flushSync();
    }
  } catch (e) { console.warn('[sync] помилка:', e.message); }
}

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 7: Sync debounce 30 секунд (було 10)
// ═══════════════════════════════════════════════════════════
function scheduleSyncDebounced() {
  if (!syncEnabled) return;
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => sendDbToAdmin('зміна даних'), 30000);
}

const _origDbSet = db.set.bind(db);
db.set = function (fn) { _origDbSet(fn); scheduleSyncDebounced(); };

app.get('/api/sync/status', adm, (_, res) => res.json({ enabled: syncEnabled }));
app.post('/api/sync/toggle', adm, async (req, res) => {
  syncEnabled = !!req.body.enabled;
  if (syncEnabled) { lastSyncHash = ''; await sendDbToAdmin('увімкнено синхронізацію'); }
  res.json({ ok: true, enabled: syncEnabled });
});
app.post('/api/sync/now', adm, async (_, res) => { lastSyncHash = ''; await sendDbToAdmin('manual'); res.json({ ok: true }); });

async function restoreDbFromTelegram() {
  try {
    const chatInfo = await tgApiJson('getChat', { chat_id: ADMIN_ID });
    const pinned = chatInfo.result?.pinned_message;
    if (!pinned || !pinned.document || pinned.document.file_name !== 'db.json') {
      syncEnabled = true;
      await sendDbToAdmin('перший запуск');
      return;
    }
    const fileInfo = await tgApiJson('getFile', { file_id: pinned.document.file_id });
    if (!fileInfo.ok) throw new Error('getFile failed');
    const fileUrl = 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + fileInfo.result.file_path;
    const fileContent = await new Promise((resolve, reject) => {
      https.get(fileUrl, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); }).on('error', reject);
    });
    const restored = JSON.parse(fileContent);
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync('data/db.json', JSON.stringify(restored, null, 2));
    if (db.reload) db.reload();
    const courses = restored.courses?.length || 0;
    const buyers = (restored.courses || []).reduce((s, c) => s + (c.buyers?.length || 0), 0);
    lastSyncHash = simpleHash(Buffer.from(fileContent, 'utf8'));
    syncEnabled = true;
    await tgApiJson('sendMessage', {
      chat_id: ADMIN_ID,
      text: `✅ *Сервер запустився*\nКурсів: ${courses}, Покупців: ${buyers}`,
      parse_mode: 'Markdown'
    }).catch(() => { });
  } catch (e) {
    console.warn('[sync] помилка відновлення:', e.message);
    syncEnabled = true;
    await sendDbToAdmin('startup');
  }
}

setTimeout(restoreDbFromTelegram, 4000);

app.get('/payment-result', (_, res) => res.sendFile(path.join(__dirname, 'public', 'payment-result.html')));
// Pages
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/course/:slug', (_, res) => res.sendFile(path.join(__dirname, 'public', 'course.html')));
app.get('/watch', (_, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/login', (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 8: Health check для UptimeRobot (без навантаження)
// ═══════════════════════════════════════════════════════════
app.get('/health', (_, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ ok: true, uptime: process.uptime() | 0, mem: Math.round(process.memoryUsage().rss / 1024 / 1024) });
});

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 9: System monitoring — RAM, CPU, навантаження
// ═══════════════════════════════════════════════════════════
app.get('/api/system', adm, (_, res) => {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();
  const cpuLoad = os.loadavg();
  const cpuCount = cpus.length;

  res.json({
    process: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    },
    system: {
      totalMem: Math.round(totalMem / 1024 / 1024),
      usedMem: Math.round(usedMem / 1024 / 1024),
      freeMem: Math.round(freeMem / 1024 / 1024),
      memPct: Math.round(usedMem / totalMem * 100),
    },
    cpu: {
      cores: cpuCount,
      model: cpus[0]?.model || 'Unknown',
      speed: cpus[0]?.speed || 0,
      load1: cpuLoad[0].toFixed(2),
      load5: cpuLoad[1].toFixed(2),
      load15: cpuLoad[2].toFixed(2),
      loadPct: Math.round(cpuLoad[0] / cpuCount * 100),
    },
    uptime: process.uptime() | 0,
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cacheSize: _responseCache.size,
    tgCacheSize: _tgFileCache.size,
    r2: { configured: r2.configured },
  });
});

// ═══ Auto-grant access to existing users every day (synced with login)
function syncAutoGrant() {
  if (AUTO_GRANT_COURSES.length === 0) return;
  db.set(d => {
    const accounts = d.buyerAccounts || [];
    for (const cid of AUTO_GRANT_COURSES) {
      const c = d.courses.find(x => x.id === cid);
      if (!c) continue;
      if (!c.buyers) c.buyers = [];
      let added = 0;
      for (const acc of accounts) {
        if (!c.buyers.some(b => b.id === acc.id)) {
          c.buyers.push({ id: acc.id, name: acc.username || '—', grantedAt: Date.now() });
          added++;
        }
      }
      if (added > 0) console.log('[autoGrant-sync] Added access for', added, 'users to course:', c.title);
    }
  });
}

// Run sync every 24 hours
setInterval(syncAutoGrant, 24 * 60 * 60 * 1000);
// Also run once on startup after 10 seconds (give server time to start)
setTimeout(syncAutoGrant, 10000);

module.exports = { app, PORT };
