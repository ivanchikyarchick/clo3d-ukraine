/**
 * index.js — Єдина точка входу
 */
const { connect } = require('./db');

connect().then(() => {
  // Завантажуємо бота (polling починається автоматично)
  require('./bot');
  
  const { app, PORT } = require('./server');
  
  const server = app.listen(PORT, () => {
    console.log(`\n🌸 Vitalia 3D Fashion Lab запущено`);
    console.log(`🌐 Сайт:   http://localhost:${PORT}`);
    console.log(`🔧 Адмін:  http://localhost:${PORT}/admin  (пароль: CL34tyre)`);
    console.log(`🎬 Плеєр:  http://localhost:${PORT}/watch`);
    console.log(`🤖 Bot:    @Clo3dua_bot`);
    console.log(`💾 RAM:    ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB\n`);
  });

  // ═══ Оптимізація: зменшуємо keep-alive та header timeout ═══
  server.keepAliveTimeout = 30000;   // 30s замість 5хв за замовчуванням
  server.headersTimeout = 35000;     // трохи більше ніж keepAlive
  server.maxHeadersCount = 50;       // обмежуємо кількість заголовків

  // ═══ Graceful shutdown ═══
  function shutdown(signal) {
    console.log(`\n[server] ${signal} received, shutting down...`);
    server.close(() => {
      console.log('[server] closed');
      process.exit(0);
    });
    // Форсуємо закриття через 10с, якщо сервер не закрився м'яко
    setTimeout(() => process.exit(1), 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ═══ Uncaught errors — не крашимо сервер ═══
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
    // Не exit — продовжуємо працювати
  });
  
  process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED]', err?.message || err);
  });

}).catch((err) => {
  console.error('[DB] Помилка підключення до бази даних:', err);
  process.exit(1);
});
