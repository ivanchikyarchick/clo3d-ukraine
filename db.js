const fs   = require('fs');
const path = require('path');
const DB   = path.join(__dirname, 'data', 'db.json');

const DEF = () => ({
  courses:  [],
  progress: {},
  settings: { fop: '' },
  stats: { botEvents:[], webEvents:[], totals:{messages:0,buyRequests:0,granted:0,videoViews:0} }
});

// ═══════════════════════════════════════════════════════════
// IN-MEMORY CACHE — головна оптимізація
// Замість читання JSON з диску на кожен запит, тримаємо все в RAM
// і зберігаємо на диск з дебаунсом (раз на 2 секунди)
// ═══════════════════════════════════════════════════════════

let _cache = null;
let _saveTimer = null;
const SAVE_DELAY = 2000; // ms — збереження на диск не частіше ніж раз на 2 секунди

function _loadFromDisk() {
  try {
    if (!fs.existsSync(DB)) {
      fs.mkdirSync(path.dirname(DB), { recursive: true });
      const d = DEF();
      fs.writeFileSync(DB, JSON.stringify(d, null, 2));
      return d;
    }
    const raw = JSON.parse(fs.readFileSync(DB, 'utf8'));
    // Migrate old single-course
    if (!raw.courses) {
      raw.courses = [];
      if (raw.course?.title) {
        raw.courses.push({ id:'1', slug:'kurs-1', title:raw.course.title,
          description:raw.course.description||'', price:raw.course.price||'',
          badge:'', color:'#5b8dee', published:true, createdAt:Date.now(),
          videos:raw.videos||[], buyers:raw.buyers||[], pending:raw.pending||[] });
      }
      delete raw.course; delete raw.videos; delete raw.buyers; delete raw.pending;
    }
    if (!raw.progress) raw.progress = {};
    if (!raw.stats) raw.stats = { botEvents:[], webEvents:[], totals:{messages:0,buyRequests:0,granted:0,videoViews:0} };
    return raw;
  } catch { return DEF(); }
}

function _scheduleSave() {
  if (_saveTimer) return; // вже заплановано
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_cache) return;
    try {
      fs.mkdirSync(path.dirname(DB), { recursive: true });
      fs.writeFileSync(DB, JSON.stringify(_cache, null, 2));
    } catch (e) {
      console.warn('[db] save error:', e.message);
    }
  }, SAVE_DELAY);
}

// Негайне збереження (для graceful shutdown)
function flushSync() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_cache) {
    try {
      fs.mkdirSync(path.dirname(DB), { recursive: true });
      fs.writeFileSync(DB, JSON.stringify(_cache, null, 2));
    } catch (e) { console.warn('[db] flush error:', e.message); }
  }
}

function connect() { return Promise.resolve(); }

function get() {
  if (!_cache) _cache = _loadFromDisk();
  return _cache;
}

function set(fn) {
  if (!_cache) _cache = _loadFromDisk();
  fn(_cache);
  _scheduleSave();
  return _cache;
}

// Повторне завантаження з диску (для sync restore)
function reload() {
  _cache = _loadFromDisk();
  return _cache;
}

function getCourse(cid) { return get().courses.find(c => c.id === cid); }
function slugify(s) { return s.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '') || Date.now().toString(); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

function getProgress(uid, cid) {
  const d = get();
  return d.progress[`${uid}_${cid}`] || { watched: [], lastIdx: 0, lastTs: null, completed: false, certIssuedAt: null };
}

function markWatched(uid, cid, idx) {
  set(d => {
    const key = `${uid}_${cid}`;
    if (!d.progress[key]) d.progress[key] = { watched: [], lastIdx: idx, lastTs: Date.now(), completed: false, certIssuedAt: null };
    const p = d.progress[key];
    p.lastIdx = idx; p.lastTs = Date.now();
    if (!p.watched.includes(idx)) p.watched.push(idx);
    const course = d.courses.find(c => c.id === cid);
    if (course && p.watched.length >= course.videos.length && !p.completed) {
      p.completed = true; p.certIssuedAt = Date.now();
    }
  });
  return getProgress(uid, cid);
}

// ═══════════════════════════════════════════════════════════
// BATCHED STATS — збираємо статистику в буфер і зберігаємо пачками
// ═══════════════════════════════════════════════════════════

let _statsBotBuffer = [];
let _statsWebBuffer = [];
let _statsFlushTimer = null;
const STATS_FLUSH_INTERVAL = 10000; // flush раз на 10 секунд

function _flushStats() {
  if (_statsBotBuffer.length === 0 && _statsWebBuffer.length === 0) return;
  const botBuf = _statsBotBuffer;
  const webBuf = _statsWebBuffer;
  _statsBotBuffer = [];
  _statsWebBuffer = [];

  set(d => {
    if (!d.stats) d.stats = { botEvents: [], webEvents: [], totals: { messages: 0, buyRequests: 0, granted: 0, videoViews: 0 } };
    for (const ev of botBuf) {
      d.stats.botEvents.push(ev);
      d.stats.totals.messages = (d.stats.totals.messages || 0) + 1;
      if (ev.type === 'buy_request') d.stats.totals.buyRequests = (d.stats.totals.buyRequests || 0) + 1;
      if (ev.type === 'granted') d.stats.totals.granted = (d.stats.totals.granted || 0) + 1;
      if (ev.type === 'video_view') d.stats.totals.videoViews = (d.stats.totals.videoViews || 0) + 1;
    }
    if (d.stats.botEvents.length > 2000) d.stats.botEvents = d.stats.botEvents.slice(-2000);
    for (const ev of webBuf) d.stats.webEvents.push(ev);
    if (d.stats.webEvents.length > 2000) d.stats.webEvents = d.stats.webEvents.slice(-2000);
  });
}

function _ensureStatsFlush() {
  if (_statsFlushTimer) return;
  _statsFlushTimer = setInterval(() => {
    _flushStats();
    if (_statsBotBuffer.length === 0 && _statsWebBuffer.length === 0) {
      clearInterval(_statsFlushTimer);
      _statsFlushTimer = null;
    }
  }, STATS_FLUSH_INTERVAL);
}

function trackBot(type, userId, userName, data = {}) {
  _statsBotBuffer.push({ type, userId, userName: userName || '', data, ts: Date.now() });
  _ensureStatsFlush();
}

function trackWeb(type, ip, reqPath, data = {}) {
  _statsWebBuffer.push({ type, ip: ip || '', path: reqPath || '', data, ts: Date.now() });
  _ensureStatsFlush();
}

// Graceful shutdown
process.on('SIGTERM', () => { _flushStats(); flushSync(); });
process.on('SIGINT',  () => { _flushStats(); flushSync(); });

module.exports = { connect, get, set, getCourse, slugify, newId, trackBot, trackWeb, getProgress, markWatched, flushSync, reload };
