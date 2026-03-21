/**
 * Vitalia 3D Fashion Lab — Telegram Bot
 * Покупка, сповіщення. БЕЗ сертифікатів, БЕЗ відео в боті.
 */
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN || '8606783327:AAFusJi5VBAqnHzdT8xP28rmzs49nT15HoM';
const ADMIN_ID  = parseInt(process.env.ADMIN_ID || '6590778330');
const SITE_URL  = process.env.SITE_URL || 'http://localhost:3000';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── helpers ─────────────────────────────────────────────────
const getBuyerCourses = uid => (db.get().courses || []).filter(c => c.buyers?.some(b => b.id === uid));
const isBuyerOf = (uid, cid) => db.getCourse(cid)?.buyers?.some(b => b.id === uid);

// Безпечне надсилання URL-кнопки (не можна з localhost)
function siteUrl(path) {
  if (!SITE_URL || SITE_URL.includes('localhost')) return null;
  return `${SITE_URL}${path}`;
}

// Повідомлення покупцю після отримання доступу
function accessGrantedMsg(courseTitle) {
  const watchUrl = siteUrl('/watch');
  return (
    `🎉 *Доступ до курсу «${courseTitle}» активовано!*\n\n` +
    `📺 *Як дивитись відео:*\n` +
    `1. Перейди на сайт: ${SITE_URL}/watch\n` +
    `2. Введи свій *Telegram ID* — це твій особистий пароль\n\n` +
    `❓ *Як дізнатись свій Telegram ID?*\n` +
    `Напиши боту @userinfobot — він покаже твій ID\n\n` +
    `Після входу одразу побачиш свої курси 🎬`
  );
}

// ── /start ──────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  const uid = msg.from.id;
  db.trackBot('start', uid, msg.from.username || msg.from.first_name);

  const myCourses    = getBuyerCourses(uid);
  const allPublished = (db.get().courses || []).filter(c => c.published);

  if (myCourses.length) {
    const courseLines = myCourses.map(c => `🎬 *${c.title}*`).join('\n');
    const keyboard = [];
    const wUrl = siteUrl('/watch');
    if (wUrl) keyboard.push([{ text: '▶️ Відкрити плеєр', url: wUrl }]);
    keyboard.push([{ text: '📊 Мій прогрес', callback_data: 'my_progress' }]);

    bot.sendMessage(uid,
      `👗 *Vitalia 3D Fashion Lab*\n\n` +
      `Ваші курси:\n${courseLines}\n\n` +
      `📺 Дивитись: ${SITE_URL}/watch\n` +
      `🔑 Для входу використовуй свій Telegram ID: \`${uid}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return;
  }

  if (!allPublished.length) {
    bot.sendMessage(uid, '🚧 Курсів поки немає. Слідкуйте за оновленнями!');
    return;
  }

  if (allPublished.length === 1) {
    const c = allPublished[0];
    const kb = [
      [{ text: '🛒 Придбати доступ', callback_data: `buy:${c.id}` }],
      [{ text: 'ℹ️ Детальніше', callback_data: `info:${c.id}` }],
    ];
    const cUrl = siteUrl(`/course/${c.slug}`);
    if (cUrl) kb.push([{ text: '🌐 Сторінка курсу', url: cUrl }]);

    bot.sendMessage(uid,
      `👗 *Vitalia 3D Fashion Lab*\n\n` +
      `✨ *${c.title}*\n\n` +
      `${c.description || ''}\n\n` +
      `${c.price ? `💳 Ціна: *${c.price}*` : ''}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
    );
    return;
  }

  // Кілька курсів
  const text = allPublished.map((c, i) =>
    `*${i+1}. ${c.title}*\n${c.description?.slice(0,80) || ''}...\n💳 ${c.price || '—'}`
  ).join('\n\n');
  bot.sendMessage(uid,
    `👗 *Vitalia 3D Fashion Lab*\n\n📚 Наші курси:\n\n${text}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard:
      allPublished.map(c => [{ text: `🛒 ${c.title}`, callback_data: `buy:${c.id}` }])
    }}
  );
});

// ── /help ───────────────────────────────────────────────────
bot.onText(/\/help/, msg => {
  const uid = msg.from.id;
  if (uid === ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
      `🔧 *Адмін-команди:*\n\n` +
      `/start — меню\n/courses — список курсів\n` +
      `/buyers — всі покупці\n/pending — заявки\n/stats — статистика\n` +
      `/grant <courseId> <userId> — видати доступ\n` +
      `/revoke <courseId> <userId> — забрати доступ\n` +
      `/broadcast <текст> — розсилка всім\n` +
      `/notify_new <courseId> [текст] — нове відео\n` +
      `/remind <courseId> — нагадування неактивним\n\n` +
      `🌐 Адмін-панель: ${SITE_URL}/admin`,
      { parse_mode: 'Markdown' }
    );
  } else {
    bot.sendMessage(uid,
      `ℹ️ *Vitalia 3D Fashion Lab*\n\n` +
      `/start — головне меню\n` +
      `/progress — мій прогрес\n\n` +
      `📺 Відеоуроки: ${SITE_URL}/watch\n` +
      `🔑 Твій Telegram ID: \`${uid}\``,
      { parse_mode: 'Markdown' }
    );
  }
});

// ── /progress ───────────────────────────────────────────────
bot.onText(/\/progress/, msg => {
  const uid = msg.from.id;
  const courses = getBuyerCourses(uid);
  if (!courses.length) {
    bot.sendMessage(uid, `У вас ще немає доступних курсів.\n\n/start — переглянути каталог`);
    return;
  }
  const lines = courses.map(c => {
    const p     = db.getProgress(uid, c.id);
    const total = c.videos?.length || 0;
    const done  = p.watched.length;
    const pct   = total ? Math.round(done/total*100) : 0;
    const bar   = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10));
    const last  = p.lastTs ? `🕐 ${new Date(p.lastTs).toLocaleDateString('uk')}` : 'Ще не починали';
    return `📚 *${c.title}*\n${bar} ${pct}%\n${done}/${total} уроків · ${last}`;
  });
  bot.sendMessage(uid,
    `📊 *Ваш прогрес:*\n\n${lines.join('\n\n')}\n\n` +
    `📺 Продовжуйте: ${SITE_URL}/watch`,
    { parse_mode: 'Markdown' }
  );
});

// ── Адмін команди ───────────────────────────────────────────
bot.onText(/\/courses/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const cs = db.get().courses || [];
  if (!cs.length) { bot.sendMessage(ADMIN_ID, 'Курсів немає.'); return; }
  bot.sendMessage(ADMIN_ID,
    cs.map((c,i) => `${i+1}. *${c.title}* \`${c.id}\`\n💳 ${c.price||'—'} · 🎬 ${c.videos?.length||0} · 👥 ${c.buyers?.length||0}`).join('\n\n'),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/stats/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const d = db.get(), t = d.stats?.totals || {};
  const cs = d.courses || [];
  bot.sendMessage(ADMIN_ID,
    `📊 *Vitalia 3D Fashion Lab — Статистика*\n\n` +
    `📚 Курсів: ${cs.length}\n` +
    `👥 Покупців: ${cs.reduce((s,c)=>s+(c.buyers?.length||0),0)}\n` +
    `⏳ Заявок: ${cs.reduce((s,c)=>s+(c.pending?.length||0),0)}\n` +
    `🎬 Відео: ${cs.reduce((s,c)=>s+(c.videos?.length||0),0)}\n` +
    `📩 Повідомлень: ${t.messages||0}\n✅ Видано: ${t.granted||0}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/buyers/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const cs = db.get().courses || [];
  const lines = [];
  cs.forEach(c => {
    if (c.buyers?.length) {
      lines.push(`*${c.title}:*`);
      c.buyers.forEach((b,i) => lines.push(`  ${i+1}. ${b.name} @${b.username||'—'} \`${b.id}\``));
    }
  });
  bot.sendMessage(ADMIN_ID, lines.join('\n') || 'Покупців немає.', { parse_mode: 'Markdown' });
});

bot.onText(/\/pending/, msg => {
  if (msg.from.id !== ADMIN_ID) return;
  const cs = db.get().courses || [];
  const lines = [];
  cs.forEach(c => {
    if (c.pending?.length) {
      lines.push(`*${c.title}:*`);
      c.pending.forEach((b,i) => lines.push(`  ${i+1}. ${b.name} @${b.username||'—'} \`${b.id}\``));
    }
  });
  bot.sendMessage(ADMIN_ID, lines.join('\n') || 'Заявок немає.', { parse_mode: 'Markdown' });
});

bot.onText(/\/grant (\S+) (\d+)/, (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  grantAccess(parseInt(m[2]), 'Невідомий', '', m[1]);
  bot.sendMessage(ADMIN_ID, `✅ Доступ видано ${m[2]}`);
});

bot.onText(/\/revoke (\S+) (\d+)/, (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  const uid = parseInt(m[2]), cid = m[1];
  db.set(d => { const c = (d.courses||[]).find(x=>x.id===cid); if(c) c.buyers=(c.buyers||[]).filter(b=>b.id!==uid); });
  bot.sendMessage(ADMIN_ID, `✅ Відкликано`);
  try { bot.sendMessage(uid, '😔 Ваш доступ відкликано.'); } catch {}
});

bot.onText(/\/broadcast (.+)/s, async (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  await doBroadcast(m[1], null);
});

bot.onText(/\/notify_new (\S+)(?: (.+))?/s, async (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  await notifyNewContent(m[1], m[2] || null);
  bot.sendMessage(ADMIN_ID, '✅ Сповіщення надіслано');
});

bot.onText(/\/remind (\S+)/, async (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  await sendReminders(m[1]);
  bot.sendMessage(ADMIN_ID, '✅ Нагадування надіслано');
});

// ── Callbacks ────────────────────────────────────────────────
bot.on('callback_query', async q => {
  const uid  = q.from.id;
  const data = q.data;
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (data === 'my_progress') {
    const courses = getBuyerCourses(uid);
    if (!courses.length) { bot.sendMessage(uid, 'У вас немає доступних курсів.'); return; }
    const lines = courses.map(c => {
      const p   = db.getProgress(uid, c.id);
      const pct = c.videos?.length ? Math.round(p.watched.length/c.videos.length*100) : 0;
      return `🎬 *${c.title}*: ${pct}% (${p.watched.length}/${c.videos?.length||0})`;
    });
    bot.sendMessage(uid, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('info:')) {
    const cid = data.split(':')[1];
    const c   = db.getCourse(cid);
    if (!c) return;
    const kb = [[{ text: '🛒 Придбати', callback_data: `buy:${c.id}` }]];
    const cUrl = siteUrl(`/course/${c.slug}`);
    if (cUrl) kb.push([{ text: '🌐 Сторінка курсу', url: cUrl }]);
    bot.sendMessage(uid,
      `📚 *${c.title}*\n\n${c.description||''}\n\n🎬 Уроків: ${c.videos?.length||0}\n💳 ${c.price||'—'}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
    );
    return;
  }

  if (data.startsWith('buy:')) {
    const cid = data.split(':')[1];
    const c   = db.getCourse(cid);
    if (!c) return;
    if (isBuyerOf(uid, cid)) {
      bot.sendMessage(uid,
        `✅ У вас вже є доступ!\n\n📺 ${SITE_URL}/watch\n🔑 Твій ID: \`${uid}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    if ((c.pending||[]).some(b => b.id === uid)) {
      bot.sendMessage(uid, '⏳ Ваш запит вже надіслано. Очікуйте підтвердження.');
      return;
    }
    const u = q.from;
    db.set(d => {
      const cx = (d.courses||[]).find(x=>x.id===cid);
      if (!cx) return;
      if (!cx.pending) cx.pending = [];
      cx.pending.push({ id: uid, name: u.first_name, username: u.username||'', requestedAt: Date.now() });
    });
    db.trackBot('buy_request', uid, u.username||u.first_name, { cid });
    bot.sendMessage(uid, '⏳ Запит надіслано! Очікуйте підтвердження оплати.');

    // Notify admin
    const totalPending = (db.get().courses||[]).reduce((s,c)=>s+(c.pending?.length||0),0);
    bot.sendMessage(ADMIN_ID,
      `🛒 *Нова заявка — ${c.title}*\n\n` +
      `👤 ${u.first_name}\n📱 @${u.username||'—'}\n🆔 \`${uid}\`\n⏳ Всього заявок: ${totalPending}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Видати доступ', callback_data: `grant:${cid}:${uid}:${encodeURIComponent(u.first_name)}:${u.username||''}` },
        { text: '❌ Відхилити',    callback_data: `reject:${cid}:${uid}` },
      ]]}}
    );
    return;
  }

  if (data.startsWith('grant:')) {
    if (uid !== ADMIN_ID) return;
    const parts = data.split(':');
    const cid   = parts[1];
    const tid   = parseInt(parts[2]);
    const name  = decodeURIComponent(parts[3] || '');
    const uname = parts[4] || '';
    grantAccess(tid, name, uname, cid);
    try {
      bot.editMessageText(q.message.text + '\n\n✅ Доступ видано.',
        { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown' });
    } catch {}
    return;
  }

  if (data.startsWith('reject:')) {
    if (uid !== ADMIN_ID) return;
    const [, cid, tidStr] = data.split(':');
    const tid = parseInt(tidStr);
    db.set(d => { const c=(d.courses||[]).find(x=>x.id===cid); if(c) c.pending=(c.pending||[]).filter(b=>b.id!==tid); });
    try {
      bot.editMessageText(q.message.text + '\n\n❌ Відхилено.',
        { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown' });
    } catch {}
    try { bot.sendMessage(tid, '😔 Ваш запит відхилено. Зверніться до адміністратора.'); } catch {}
    return;
  }
});

// ── grantAccess ─────────────────────────────────────────────
function grantAccess(uid, name, username, cid) {
  db.set(d => {
    const c = (d.courses||[]).find(x => x.id === cid);
    if (!c) return;
    if (!c.buyers) c.buyers = [];
    if (!c.buyers.some(b => b.id === uid)) c.buyers.push({ id: uid, name, username, grantedAt: Date.now() });
    c.pending = (c.pending||[]).filter(b => b.id !== uid);
  });
  db.trackBot('granted', uid, username, { cid });
  const c = db.getCourse(cid);
  try {
    bot.sendMessage(uid, accessGrantedMsg(c?.title || 'курсу'), { parse_mode: 'Markdown' });
  } catch(e) { console.warn('grantAccess sendMessage error:', e.message); }
}

// ── Notifications ────────────────────────────────────────────
async function notifyNewContent(cid, customText) {
  const c = db.getCourse(cid);
  if (!c) return { sent:0, failed:0 };
  const msg = customText ||
    `🎬 *Новий урок у курсі «${c.title}»!*\n\nПереходь та дивись: ${SITE_URL}/watch`;
  let ok=0, fail=0;
  for (const b of (c.buyers||[])) {
    try { await bot.sendMessage(b.id, msg, {parse_mode:'Markdown'}); ok++; await delay(60); }
    catch { fail++; }
  }
  return { sent:ok, failed:fail };
}

async function sendReminders(cid) {
  const c = db.getCourse(cid);
  if (!c) return;
  const now = Date.now(), week = 7*24*60*60*1000;
  const msgs = [
    `👋 Привіт! Не забувай про курс *«${c.title}»*!\nПродовж: ${SITE_URL}/watch`,
    `🎯 Твій прогрес у *«${c.title}»* чекає! ${SITE_URL}/watch`,
    `⏰ Давно не бачились! Повернись до *«${c.title}»*: ${SITE_URL}/watch`,
  ];
  for (const b of (c.buyers||[])) {
    const p = db.getProgress(b.id, cid);
    if (p.lastTs && now - p.lastTs < week) continue;
    try { await bot.sendMessage(b.id, msgs[Math.floor(Math.random()*msgs.length)], {parse_mode:'Markdown'}); await delay(60); }
    catch {}
  }
}

async function doBroadcast(text, cid) {
  const seen = new Set(), all = [];
  for (const c of (db.get().courses||[])) {
    if (cid && c.id !== cid) continue;
    for (const b of (c.buyers||[])) { if (!seen.has(b.id)) { seen.add(b.id); all.push(b); } }
  }
  let ok=0, fail=0;
  for (const b of all) {
    try { await bot.sendMessage(b.id, `📢 *Vitalia 3D Fashion Lab:*\n\n${text}`, {parse_mode:'Markdown'}); ok++; await delay(60); }
    catch { fail++; }
  }
  try { bot.sendMessage(ADMIN_ID, `📢 Розсилка: ✅ ${ok} | ❌ ${fail}`); } catch {}
  return { sent:ok, failed:fail };
}

// Щоденний дайджест
function scheduleDailyDigest() {
  const now = new Date(), next = new Date(now);
  next.setHours(10,0,0,0);
  if (next <= now) next.setDate(next.getDate()+1);
  setTimeout(() => {
    runDigest();
    setInterval(runDigest, 24*60*60*1000);
  }, next - now);
}
async function runDigest() {
  const pending = (db.get().courses||[]).reduce((s,c)=>s+(c.pending?.length||0),0);
  if (!pending) return;
  const lines = (db.get().courses||[]).filter(c=>c.pending?.length).map(c=>`• *${c.title}*: ${c.pending.length}`);
  try { await bot.sendMessage(ADMIN_ID, `📬 *Дайджест*\n\n⏳ Заявки (${pending}):\n${lines.join('\n')}\n\n/pending`, {parse_mode:'Markdown'}); } catch {}
}
scheduleDailyDigest();

const delay = ms => new Promise(r => setTimeout(r, ms));

module.exports = { bot, doBroadcast, grantAccess, notifyNewContent, sendReminders };