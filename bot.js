/**
 * bot_v2.js — OPTIMIZED for 0.1 CPU / 512MB RAM
 * 
 * Changes:
 * 1. Polling interval increased to 3s (default 300ms = CPU killer)
 * 2. Delay between bulk messages increased to 200ms (was 60ms)
 * 3. Error handling won't crash process
 * 4. Daily digest only if pending > 0 (no empty messages)
 */

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN || '8606783327:AAFlvRiAqhxLuxwtx_6l4glNeqlSS4x96AE';
const ADMIN_ID  = parseInt(process.env.ADMIN_ID || '6590778330');
const SITE_URL  = process.env.SITE_URL || 'https://fashionlab.com.ua';

// ═══════════════════════════════════════════════════════════
// ОПТИМІЗАЦІЯ 1: Збільшений polling interval (3 секунди замість 300мс)
// На 0.1 CPU це критично — зменшує CPU використання на ~50%
// ═══════════════════════════════════════════════════════════
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 3000,        // перевіряти раз на 3 секунди (замість 300мс)
    autoStart: true,
    params: {
      timeout: 30          // long polling 30s (зменшує кількість запитів)
    }
  }
});

// ═══ Обробка помилок — не крашимо процес ═══
bot.on('polling_error', (err) => {
  // Не логуємо кожну помилку — тільки серйозні
  if (err.code !== 'ETELEGRAM' && err.code !== 'EFATAL') {
    console.warn('[bot] polling error:', err.message);
  }
});

const getBuyerCourses = uid => (db.get().courses || []).filter(c => c.buyers?.some(b => b.id === uid));
const isBuyerOf = (uid, cid) => db.getCourse(cid)?.buyers?.some(b => b.id === uid);
const delay = ms => new Promise(r => setTimeout(r, ms));
const getFop = () => db.get().settings?.fop || '';

const waitingPhone = {};
const waitingIndividual = {};

function accessGrantedMsg(uid, title) {
  return `*Доступ до курсу «${title}» активовано!*\n\n` +
    `Як дивитись:\n` +
    `1. Перейди на: ${SITE_URL}/watch\n` +
    `2. Введи свій *Telegram ID* як пароль\n\n` +
    `Твiй Telegram ID: \`${uid}\`\n\n` +
    `_Скопiюй цей номер i встав у поле "Telegram ID" на сайтi._`;
}

bot.onText(/\/start/, msg => {
  const uid = msg.from.id;
  db.trackBot('start', uid, msg.from.username || msg.from.first_name);
  const mine = getBuyerCourses(uid), kb = [];
  if (mine.length) { kb.push([{ text: 'Мої курси', callback_data: 'my_courses' }], [{ text: 'Мій прогрес', callback_data: 'my_progress' }]); }
  kb.push([{ text: 'Придбати курс', callback_data: 'catalogue' }], [{ text: '🎯 Індивідуальний розбір', callback_data: 'individual' }]);
  bot.sendMessage(uid, `*Vitaliia 3D Fashion Lab*\n\nCLO 3D українською\n\nОберіть дію:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
});

bot.onText(/\/help/, msg => {
  const uid = msg.from.id;
  if (uid === ADMIN_ID) {
    bot.sendMessage(ADMIN_ID, `*Адмін-команди:*\n/start /courses /buyers /pending /stats\n/grant <courseId> <userId>\n/revoke <courseId> <userId>\n/broadcast <текст>\n\nАдмін: ${SITE_URL}/admin`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(uid, `/start — меню\n/progress — прогрес\n\n${SITE_URL}/watch\nТвій ID: \`${uid}\``, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/progress/, msg => {
  const uid = msg.from.id, courses = getBuyerCourses(uid);
  if (!courses.length) { bot.sendMessage(uid, 'Немає доступних курсів. /start'); return; }
  const lines = courses.map(c => {
    const p = db.getProgress(uid, c.id), total = c.videos?.length || 0, done = p.watched.length, pct = total ? Math.round(done / total * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `*${c.title}*\n${bar} ${pct}% (${done}/${total})`;
  });
  bot.sendMessage(uid, lines.join('\n\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/courses/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const cs = db.get().courses || [];
  if (!cs.length) { bot.sendMessage(ADMIN_ID, 'Курсів немає.'); return; }
  bot.sendMessage(ADMIN_ID, cs.map((c, i) => `${i + 1}. *${c.title}* \`${c.id}\`\n${c.price || '—'} · ${c.videos?.length || 0} відео · ${c.buyers?.length || 0} учнів`).join('\n\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const d = db.get(), t = d.stats?.totals || {}, cs = d.courses || [];
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  bot.sendMessage(ADMIN_ID,
    `*Статистика*\n\nКурсів: ${cs.length}\nПокупців: ${cs.reduce((s, c) => s + (c.buyers?.length || 0), 0)}\nЗаявок: ${cs.reduce((s, c) => s + (c.pending?.length || 0), 0)}\nВідео: ${cs.reduce((s, c) => s + (c.videos?.length || 0), 0)}\nПовідомлень: ${t.messages || 0}\nВидано доступів: ${t.granted || 0}\n\n💾 RAM: ${mem}MB`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/buyers/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const lines = [];
  (db.get().courses || []).forEach(c => { if (c.buyers?.length) { lines.push(`*${c.title}:*`); c.buyers.forEach((b, i) => lines.push(`  ${i + 1}. ${b.name} @${b.username || '—'} \`${b.id}\``)); } });
  bot.sendMessage(ADMIN_ID, lines.join('\n') || 'Покупців немає.', { parse_mode: 'Markdown' });
});

bot.onText(/\/pending/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const lines = [];
  (db.get().courses || []).forEach(c => { if (c.pending?.length) { lines.push(`*${c.title}:*`); c.pending.forEach((b, i) => lines.push(`  ${i + 1}. ${b.name} @${b.username || '—'} \`${b.id}\` ${b.receiptFileId ? '📎 квитанція' : ''}`)); } });
  bot.sendMessage(ADMIN_ID, lines.join('\n') || 'Заявок немає.', { parse_mode: 'Markdown' });
});

bot.onText(/\/grant (\S+) (\d+)/, (msg, m) => { if (msg.from.id !== ADMIN_ID) return; grantAccess(parseInt(m[2]), 'Невідомий', '', m[1]); bot.sendMessage(ADMIN_ID, `Доступ видано ${m[2]}`); });
bot.onText(/\/revoke (\S+) (\d+)/, (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  const uid = parseInt(m[2]), cid = m[1];
  db.set(d => { const c = (d.courses || []).find(x => x.id === cid); if (c) c.buyers = (c.buyers || []).filter(b => b.id !== uid); });
  bot.sendMessage(ADMIN_ID, 'Відкликано');
  try { bot.sendMessage(uid, 'Ваш доступ відкликано.'); } catch { }
});
bot.onText(/\/broadcast (.+)/s, async (msg, m) => { if (msg.from.id !== ADMIN_ID) return; await doBroadcast(m[1], null); });
bot.onText(/\/notify_new (\S+)(?: (.+))?/s, async (msg, m) => { if (msg.from.id !== ADMIN_ID) return; await notifyNewContent(m[1], m[2] || null); bot.sendMessage(ADMIN_ID, 'Сповіщення надіслано'); });
bot.onText(/\/remind (\S+)/, async (msg, m) => { if (msg.from.id !== ADMIN_ID) return; await sendReminders(m[1]); bot.sendMessage(ADMIN_ID, 'Нагадування надіслано'); });

bot.on('callback_query', async q => {
  const uid = q.from.id, data = q.data;
  await bot.answerCallbackQuery(q.id).catch(() => { });

  if (data === 'my_courses') {
    const courses = getBuyerCourses(uid);
    if (!courses.length) { bot.sendMessage(uid, 'Немає куплених курсів. /start'); return; }
    bot.sendMessage(uid,
      `*Ваші курси:*\n\n${courses.map(c => `${c.title}`).join('\n')}\n\n${SITE_URL}/watch\nID: \`${uid}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Відкрити плеєр', url: `${SITE_URL}/watch` }], [{ text: 'Мій прогрес', callback_data: 'my_progress' }]] } }
    ); return;
  }

  if (data === 'catalogue') {
    const all = (db.get().courses || []).filter(c => c.published);
    if (!all.length) { bot.sendMessage(uid, 'Курсів поки немає.'); return; }
    const text = all.map((c, i) => `*${i + 1}. ${c.title}*\n${c.description?.slice(0, 100) || ''}\n${c.price || '—'} · ${c.videos?.length || 0} уроків`).join('\n\n');
    bot.sendMessage(uid, `*Наші курси:*\n\n${text}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: all.map(c => [{ text: `${c.title} — ${c.price || '?'}`, callback_data: `buy:${c.id}` }]) } });
    return;
  }

  if (data === 'my_progress') {
    const courses = getBuyerCourses(uid);
    if (!courses.length) { bot.sendMessage(uid, 'Немає доступних курсів.'); return; }
    bot.sendMessage(uid, courses.map(c => { const p = db.getProgress(uid, c.id); const pct = c.videos?.length ? Math.round(p.watched.length / c.videos.length * 100) : 0; return `*${c.title}*: ${pct}% (${p.watched.length}/${c.videos?.length || 0})`; }).join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('info:')) {
    const cid = data.split(':')[1], c = db.getCourse(cid); if (!c) return;
    bot.sendMessage(uid, `*${c.title}*\n\n${c.description || ''}\n\nУроків: ${c.videos?.length || 0}\n${c.price || '—'}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Придбати', callback_data: `buy:${c.id}` }]] } });
    return;
  }

  if (data.startsWith('buy:')) {
    const cid = data.split(':')[1], c = db.getCourse(cid); if (!c) return;
    if (isBuyerOf(uid, cid)) { bot.sendMessage(uid, `У вас вже є доступ!\n\n${SITE_URL}/watch\nID: \`${uid}\``, { parse_mode: 'Markdown' }); return; }
    if ((c.pending || []).some(b => b.id === uid)) { bot.sendMessage(uid, 'Ваш запит вже надіслано. Очікуйте підтвердження.'); return; }
    waitingPhone[uid] = { cid, courseName: c.title };
    const fop = getFop();
    let msg = `*${c.title}*\nЦіна: ${c.price || '—'}\n\n`;
    if (fop) msg += `*Реквізити ФОП:*\n\`${fop}\`\n\n`;
    msg += `Надішліть **фото квитанції** про оплату для підтвердження:`;
    bot.sendMessage(uid, msg, { parse_mode: 'Markdown' });
    return;
  }

  if (data === 'individual') {
    waitingIndividual[uid] = true;
    const fop = getFop();
    let msg = `*Індивідуальний розбір*\n💰 Ціна: 800 грн\n\n`;
    if (fop) msg += `*Реквізити для оплати:*\n\`${fop}\`\n\n`;
    msg += `Надішліть **фото квитанції** про оплату для підтвердження:`;
    bot.sendMessage(uid, msg, { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('grant-individual:')) {
    if (uid !== ADMIN_ID) return;
    const tid = parseInt(data.split(':')[1]);
    db.set(d => {
      if (!d.individualRequests) d.individualRequests = [];
      const req = d.individualRequests.find(r => r.id === tid);
      if (req) req.status = 'granted';
    });
    try { bot.editMessageText(q.message.text + '\n\n✅ Доступ видано!', { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown' }); } catch { }
    try { bot.sendMessage(tid, '🎉 Ваш індивідуальний розбір підтверджено! Очікуйте на зв\'язок для узгодження часу.'); } catch { }
    return;
  }

  if (data.startsWith('reject-individual:')) {
    if (uid !== ADMIN_ID) return;
    const tid = parseInt(data.split(':')[1]);
    db.set(d => {
      if (!d.individualRequests) d.individualRequests = [];
      const idx = d.individualRequests.findIndex(r => r.id === tid);
      if (idx > -1) d.individualRequests.splice(idx, 1);
    });
    try { bot.editMessageText(q.message.text + '\n\n❌ Відхилено.', { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown' }); } catch { }
    try { bot.sendMessage(tid, 'На жаль, вашу заявку на індивідуальний розбір відхилено. Зверніться до адміністратора.'); } catch { }
    return;
  }

  if (data.startsWith('grant:')) {
    if (uid !== ADMIN_ID) return;
    const parts = data.split(':');
    grantAccess(parseInt(parts[2]), decodeURIComponent(parts[3] || ''), parts[4] || '', parts[1]);
    try { bot.editMessageText(q.message.text + '\n\nДоступ видано.', { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown' }); } catch { }
    return;
  }

  if (data.startsWith('reject:')) {
    if (uid !== ADMIN_ID) return;
    const [, cid, tidStr] = data.split(':'), tid = parseInt(tidStr);
    db.set(d => { const c = (d.courses || []).find(x => x.id === cid); if (c) c.pending = (c.pending || []).filter(b => b.id !== tid); });
    try { bot.editMessageText(q.message.text + '\n\nВідхилено.', { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown' }); } catch { }
    try { bot.sendMessage(tid, 'Ваш запит відхилено.'); } catch { }
    return;
  }
});

bot.on('photo', async msg => {
  const uid = msg.from.id;
  
  // Handle course purchase
  if (waitingPhone[uid]) {
    const { cid } = waitingPhone[uid]; delete waitingPhone[uid];
    const c = db.getCourse(cid); if (!c) return;
    const u = msg.from;
    const photo = msg.photo[msg.photo.length - 1];
    const receiptFileId = photo.file_id;
    db.set(d => { const cx = (d.courses || []).find(x => x.id === cid); if (!cx) return; if (!cx.pending) cx.pending = []; if (!cx.pending.some(b => b.id === uid)) cx.pending.push({ id: uid, name: u.first_name, username: u.username || '', phone: '', receiptFileId, requestedAt: Date.now() }); });
    db.trackBot('buy_request', uid, u.username || u.first_name, { cid });
    bot.sendMessage(uid, 'Заявку відправлено! Очікуйте підтвердження оплати.');
    const total = (db.get().courses || []).reduce((s, c) => s + (c.pending?.length || 0), 0);
    const fop = getFop();
    let adminMsg = `*Нова заявка — ${c.title}*\n\n👤 ${u.first_name} @${u.username || '—'}\nID: \`${uid}\``;
    if (fop) adminMsg += `\n\nФОП: \`${fop}\``;
    adminMsg += `\n\nЗаявок: ${total}`;
    try {
      await bot.sendPhoto(ADMIN_ID, receiptFileId, { caption: adminMsg, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Видати доступ', callback_data: `grant:${cid}:${uid}:${encodeURIComponent(u.first_name)}:${u.username || ''}` }, { text: 'Відхилити', callback_data: `reject:${cid}:${uid}` }]] } });
    } catch {
      bot.sendMessage(ADMIN_ID, adminMsg + '\n\n📎 Квитанція (не вдалось показати)', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Видати доступ', callback_data: `grant:${cid}:${uid}:${encodeURIComponent(u.first_name)}:${u.username || ''}` }, { text: 'Відхилити', callback_data: `reject:${cid}:${uid}` }]] } });
    }
    return;
  }
  
  // Handle individual service purchase
  if (waitingIndividual[uid]) {
    delete waitingIndividual[uid];
    const u = msg.from;
    const photo = msg.photo[msg.photo.length - 1];
    const receiptFileId = photo.file_id;
    db.set(d => { if (!d.individualRequests) d.individualRequests = []; d.individualRequests.push({ id: uid, name: u.first_name, username: u.username || '', receiptFileId, requestedAt: Date.now() }); });
    db.trackBot('individual_request', uid, u.username || u.first_name, {});
    bot.sendMessage(uid, 'Заявку відправлено! Очікуйте підтвердження. Ми зв\'яжемося з вами для узгодження часу.');
    const total = (db.get().individualRequests || []).length;
    let adminMsg = `*Нова заявка — Індивідуальний розбір*\n\n👤 ${u.first_name} @${u.username || '—'}\nID: \`${uid}\`\n\nЗаявок: ${total}`;
    try {
      await bot.sendPhoto(ADMIN_ID, receiptFileId, { caption: adminMsg, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Підтвердити', callback_data: `grant-individual:${uid}` }, { text: 'Відхилити', callback_data: `reject-individual:${uid}` }]] } });
    } catch {
      bot.sendMessage(ADMIN_ID, adminMsg + '\n\n📎 Квитанція (не вдалось показати)', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Підтвердити', callback_data: `grant-individual:${uid}` }, { text: 'Відхилити', callback_data: `reject-individual:${uid}` }]] } });
    }
    return;
  }
});

bot.on('message', msg => {
  const uid = msg.from.id;
  if (!waitingPhone[uid]) return;
  if (msg.photo) return;
  bot.sendMessage(uid, 'Надішліть **фото** квитанції про оплату, а не текст.', { parse_mode: 'Markdown' });
});

function grantAccess(uid, name, username, cid) {
  db.set(d => { const c = (d.courses || []).find(x => x.id === cid); if (!c) return; if (!c.buyers) c.buyers = []; if (!c.buyers.some(b => b.id === uid)) c.buyers.push({ id: uid, name, username, grantedAt: Date.now() }); c.pending = (c.pending || []).filter(b => b.id !== uid); });
  db.trackBot('granted', uid, username, { cid });
  const c = db.getCourse(cid);
  try { bot.sendMessage(uid, accessGrantedMsg(uid, c?.title || 'курсу'), { parse_mode: 'Markdown' }); } catch (e) { console.warn('grantAccess:', e.message); }
}

// ═══ Збільшений delay між повідомленнями (200мс замість 60мс) ═══
async function notifyNewContent(cid, customText) {
  const c = db.getCourse(cid); if (!c) return { sent: 0, failed: 0 };
  const msg = customText || `Новий урок у «${c.title}»!\n\n${SITE_URL}/watch`;
  let ok = 0, fail = 0;
  for (const b of (c.buyers || [])) { try { await bot.sendMessage(b.id, msg, { parse_mode: 'Markdown' }); ok++; await delay(200); } catch { fail++; } }
  return { sent: ok, failed: fail };
}

async function sendReminders(cid) {
  const c = db.getCourse(cid); if (!c) return;
  const now = Date.now(), week = 7 * 24 * 60 * 60 * 1000;
  const msgs = [`Не забувай про «${c.title}»!\n${SITE_URL}/watch`, `Твій прогрес чекає! «${c.title}»\n${SITE_URL}/watch`];
  for (const b of (c.buyers || [])) {
    const p = db.getProgress(b.id, cid);
    if (p.lastTs && now - p.lastTs < week) continue;
    try { await bot.sendMessage(b.id, msgs[Math.floor(Math.random() * msgs.length)], { parse_mode: 'Markdown' }); await delay(200); } catch { }
  }
}

async function doBroadcast(text, cid) {
  const seen = new Set(), all = [];
  for (const c of (db.get().courses || [])) { if (cid && c.id !== cid) continue; for (const b of (c.buyers || [])) { if (!seen.has(b.id)) { seen.add(b.id); all.push(b); } } }
  let ok = 0, fail = 0;
  for (const b of all) { try { await bot.sendMessage(b.id, `*Vitaliia 3D Fashion Lab:*\n\n${text}`, { parse_mode: 'Markdown' }); ok++; await delay(200); } catch { fail++; } }
  try { bot.sendMessage(ADMIN_ID, `Розсилка: ${ok} ок / ${fail} помилок`); } catch { }
  return { sent: ok, failed: fail };
}

function scheduleDailyDigest() {
  const now = new Date(), next = new Date(now);
  next.setHours(10, 0, 0, 0); if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { runDigest(); setInterval(runDigest, 24 * 60 * 60 * 1000); }, next - now);
}
async function runDigest() {
  const pending = (db.get().courses || []).reduce((s, c) => s + (c.pending?.length || 0), 0);
  if (!pending) return;
  const lines = (db.get().courses || []).filter(c => c.pending?.length).map(c => `• *${c.title}*: ${c.pending.length}`);
  try { await bot.sendMessage(ADMIN_ID, `*Дайджест*\n\nЗаявок (${pending}):\n${lines.join('\n')}\n\n/pending`, { parse_mode: 'Markdown' }); } catch { }
}
scheduleDailyDigest();

module.exports = { bot, doBroadcast, grantAccess, notifyNewContent, sendReminders };
