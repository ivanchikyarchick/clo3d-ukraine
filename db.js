/**
 * db_v2.js — ULTRA-OPTIMIZED for 0.1 CPU / 512MB RAM
 * Storage: Cloudflare R2 (primary) + local /tmp fallback
 */

const fs   = require('fs');
const path = require('path');

// Use /tmp for ephemeral local cache (Render wipes disk on restart)
const DB_LOCAL = '/tmp/vfl_db_cache.json';
const R2_DB_KEY = 'db/db.json';

// Lazy-load r2 to avoid circular deps
let _r2 = null;
function getR2() {
  if (!_r2) _r2 = require('./r2');
  return _r2;
}

const DEF = () => ({
  courses:  [],
  progress: {},
  settings: { fop: '' },
  stats: { botEvents: [], webEvents: [], totals: { messages: 0, buyRequests: 0, granted: 0, videoViews: 0 } }
});

let _cache = null;
let _saveTimer = null;
let _saving = false;
const SAVE_DELAY = 5000;

const MAX_EVENTS = 500;
const MAX_PROGRESS_ENTRIES = 500;

function _loadFromDisk() {
  try {
    if (!fs.existsSync(DB_LOCAL)) {
      const d = DEF();
      return d;
    }
    const raw = JSON.parse(fs.readFileSync(DB_LOCAL, 'utf8'));
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
    if (raw.stats.botEvents?.length > MAX_EVENTS) raw.stats.botEvents = raw.stats.botEvents.slice(-MAX_EVENTS);
    if (raw.stats.webEvents?.length > MAX_EVENTS) raw.stats.webEvents = raw.stats.webEvents.slice(-MAX_EVENTS);
    _trimProgress(raw);
    return raw;
  } catch { return DEF(); }
}

function _trimProgress(d) {
  const keys = Object.keys(d.progress || {});
  if (keys.length <= MAX_PROGRESS_ENTRIES) return;
  const sorted = keys.map(k => ({ k, ts: d.progress[k].lastTs || 0 })).sort((a, b) => a.ts - b.ts);
  const toRemove = sorted.slice(0, keys.length - MAX_PROGRESS_ENTRIES);
  for (const { k } of toRemove) delete d.progress[k];
}

// ─── R2 persistence ──────────────────────────────────────────────────────────

async function loadFromR2() {
  const r2 = getR2();
  if (!r2.configured) return null;
  try {
    const data = await r2.downloadFile(R2_DB_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data);
    // Write to local cache
    fs.writeFileSync(DB_LOCAL, data, 'utf8');
    console.log('[db] Loaded from R2, courses:', parsed.courses?.length || 0);
    return parsed;
  } catch (e) {
    console.warn('[db] R2 load error:', e.message);
    return null;
  }
}

async function saveToR2(data) {
  const r2 = getR2();
  if (!r2.configured) return;
  try {
    const json = JSON.stringify(data, null, 2);
    await r2.uploadBuffer(R2_DB_KEY, Buffer.from(json, 'utf8'), 'application/json; charset=utf-8');
    console.log('[db] Saved to R2');
  } catch (e) {
    console.warn('[db] R2 save error:', e.message);
  }
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (!_cache || _saving) return;
    _saving = true;
    try {
      const data = JSON.stringify(_cache, null, 2);
      // Save to local cache
      fs.writeFileSync(DB_LOCAL, data, 'utf8');
      // Save to R2
      await saveToR2(_cache);
    } catch (e) {
      console.warn('[db] save error:', e.message);
    } finally {
      _saving = false;
    }
  }, SAVE_DELAY);
}

function flushSync() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_cache) {
    try {
      fs.writeFileSync(DB_LOCAL, JSON.stringify(_cache, null, 2), 'utf8');
    } catch (e) { console.warn('[db] flush error:', e.message); }
    // Async R2 save (best effort)
    saveToR2(_cache).catch(() => {});
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

// Initialize: try R2 first, fallback to local
async function init() {
  const fromR2 = await loadFromR2();
  if (fromR2) {
    _cache = fromR2;
    if (!_cache.courses) _cache.courses = [];
    if (!_cache.progress) _cache.progress = {};
    if (!_cache.stats) _cache.stats = DEF().stats;
    _trimProgress(_cache);
  } else {
    _cache = _loadFromDisk();
  }
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
    _checkMemoryPressure();
    if (_statsBotBuffer.length === 0 && _statsWebBuffer.length === 0) {
      clearInterval(_statsFlushTimer);
      _statsFlushTimer = null;
    }
  }, STATS_FLUSH_INTERVAL);
}

function _checkMemoryPressure() {
  const rss = process.memoryUsage().rss;
  if (rss > 400 * 1024 * 1024) {
    console.warn(`[db] Memory pressure: ${Math.round(rss / 1024 / 1024)}MB — trimming`);
    if (_cache?.stats) {
      if (_cache.stats.botEvents?.length > 200) _cache.stats.botEvents = _cache.stats.botEvents.slice(-200);
      if (_cache.stats.webEvents?.length > 200) _cache.stats.webEvents = _cache.stats.webEvents.slice(-200);
    }
    _trimProgress(_cache || {});
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

process.on('SIGTERM', () => { _flushStats(); flushSync(); process.exit(0); });
process.on('SIGINT', () => { _flushStats(); flushSync(); process.exit(0); });

module.exports = { connect, get, set, getCourse, slugify, newId, trackBot, trackWeb, getProgress, markWatched, flushSync, reload, init };
