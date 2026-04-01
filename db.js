/**
 * db_v2.js — ULTRA-OPTIMIZED for 0.1 CPU / 512MB RAM
 * 
 * Changes from v1:
 * 1. Stats arrays hard-capped at 500 (was 2000)
 * 2. Save debounce increased to 5s (was 2s)
 * 3. Stats flush every 30s (was 10s) 
 * 4. writeFile is async (non-blocking) instead of writeFileSync
 * 5. Memory pressure monitoring — auto-trim stats if RAM > 400MB
 * 6. Compact JSON (no pretty-print) to save CPU on stringify
 */

const fs   = require('fs');
const path = require('path');
const DB   = path.join(__dirname, 'data', 'db.json');

const DEF = () => ({
  courses:  [],
  progress: {},
  settings: { fop: '' },
  stats: { botEvents: [], webEvents: [], totals: { messages: 0, buyRequests: 0, granted: 0, videoViews: 0 } }
});

let _cache = null;
let _saveTimer = null;
let _saving = false;
const SAVE_DELAY = 5000; // 5s (було 2s)

// ═══ Stats limits ═══
const MAX_EVENTS = 500;        // було 2000
const MAX_PROGRESS_ENTRIES = 500;

function _loadFromDisk() {
  try {
    if (!fs.existsSync(DB)) {
      fs.mkdirSync(path.dirname(DB), { recursive: true });
      const d = DEF();
      fs.writeFileSync(DB, JSON.stringify(d));
      return d;
    }
    const raw = JSON.parse(fs.readFileSync(DB, 'utf8'));
    if (!raw.courses) {
      raw.courses = [];
      if (raw.course?.title) {
        raw.courses.push({ id: '1', slug: 'kurs-1', title: raw.course.title,
          description: raw.course.description || '', price: raw.course.price || '',
          badge: '', color: '#5b8dee', published: true, createdAt: Date.now(),
          videos: raw.videos || [], buyers: raw.buyers || [], pending: raw.pending || [] });
      }
      delete raw.course; delete raw.videos; delete raw.buyers; delete raw.pending;
    }
    if (!raw.progress) raw.progress = {};
    if (!raw.stats) raw.stats = DEF().stats;
    // Підрізаємо масиви при завантаженні
    if (raw.stats.botEvents?.length > MAX_EVENTS) raw.stats.botEvents = raw.stats.botEvents.slice(-MAX_EVENTS);
    if (raw.stats.webEvents?.length > MAX_EVENTS) raw.stats.webEvents = raw.stats.webEvents.slice(-MAX_EVENTS);
    // Підрізаємо прогрес
    _trimProgress(raw);
    return raw;
  } catch { return DEF(); }
}

function _trimProgress(d) {
  const keys = Object.keys(d.progress || {});
  if (keys.length <= MAX_PROGRESS_ENTRIES) return;
  // Видаляємо найстаріші
  const sorted = keys.map(k => ({ k, ts: d.progress[k].lastTs || 0 })).sort((a, b) => a.ts - b.ts);
  const toRemove = sorted.slice(0, keys.length - MAX_PROGRESS_ENTRIES);
  for (const { k } of toRemove) delete d.progress[k];
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_cache || _saving) return;
    _saving = true;
    try {
      fs.mkdirSync(path.dirname(DB), { recursive: true });
      // Async write — не блокуємо event loop
      const data = JSON.stringify(_cache); // compact — без pretty print
      fs.writeFile(DB, data, (err) => {
        _saving = false;
        if (err) console.warn('[db] save error:', err.message);
      });
    } catch (e) {
      _saving = false;
      console.warn('[db] save error:', e.message);
    }
  }, SAVE_DELAY);
}

function flushSync() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_cache) {
    try {
      fs.mkdirSync(path.dirname(DB), { recursive: true });
      fs.writeFileSync(DB, JSON.stringify(_cache));
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
// BATCHED STATS — flush кожні 30 секунд (було 10)
// ═══════════════════════════════════════════════════════════
let _statsBotBuffer = [];
let _statsWebBuffer = [];
let _statsFlushTimer = null;
const STATS_FLUSH_INTERVAL = 30000;

function _flushStats() {
  if (_statsBotBuffer.length === 0 && _statsWebBuffer.length === 0) return;
  const botBuf = _statsBotBuffer;
  const webBuf = _statsWebBuffer;
  _statsBotBuffer = [];
  _statsWebBuffer = [];

  set(d => {
    if (!d.stats) d.stats = DEF().stats;
    for (const ev of botBuf) {
      d.stats.botEvents.push(ev);
      d.stats.totals.messages = (d.stats.totals.messages || 0) + 1;
      if (ev.type === 'buy_request') d.stats.totals.buyRequests = (d.stats.totals.buyRequests || 0) + 1;
      if (ev.type === 'granted') d.stats.totals.granted = (d.stats.totals.granted || 0) + 1;
      if (ev.type === 'video_view') d.stats.totals.videoViews = (d.stats.totals.videoViews || 0) + 1;
    }
    if (d.stats.botEvents.length > MAX_EVENTS) d.stats.botEvents = d.stats.botEvents.slice(-MAX_EVENTS);
    for (const ev of webBuf) d.stats.webEvents.push(ev);
    if (d.stats.webEvents.length > MAX_EVENTS) d.stats.webEvents = d.stats.webEvents.slice(-MAX_EVENTS);
  });
}

function _ensureStatsFlush() {
  if (_statsFlushTimer) return;
  _statsFlushTimer = setInterval(() => {
    _flushStats();
    // Перевірка RAM
    _checkMemoryPressure();
    if (_statsBotBuffer.length === 0 && _statsWebBuffer.length === 0) {
      clearInterval(_statsFlushTimer);
      _statsFlushTimer = null;
    }
  }, STATS_FLUSH_INTERVAL);
}

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ: Memory pressure — якщо RAM > 400MB, скидаємо кеші
// ═══════════════════════════════════════════════════════════
function _checkMemoryPressure() {
  const rss = process.memoryUsage().rss;
  if (rss > 400 * 1024 * 1024) {
    console.warn(`[db] Memory pressure: ${Math.round(rss / 1024 / 1024)}MB — trimming`);
    if (_cache?.stats) {
      if (_cache.stats.botEvents?.length > 200) _cache.stats.botEvents = _cache.stats.botEvents.slice(-200);
      if (_cache.stats.webEvents?.length > 200) _cache.stats.webEvents = _cache.stats.webEvents.slice(-200);
    }
    _trimProgress(_cache || {});
    // Підказка GC
    if (global.gc) global.gc();
  }
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
process.on('SIGTERM', () => { _flushStats(); flushSync(); process.exit(0); });
process.on('SIGINT', () => { _flushStats(); flushSync(); process.exit(0); });

module.exports = { connect, get, set, getCourse, slugify, newId, trackBot, trackWeb, getProgress, markWatched, flushSync, reload };
