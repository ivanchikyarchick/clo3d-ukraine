/**
 * index.js — Єдина точка входу
 */
const { connect } = require('./db');

connect().then(() => {
  const { app, PORT } = require('./server');
  
  const server = app.listen(PORT, () => {
    console.log(`\n🌸 Vitalia 3D Fashion Lab запущено`);
    console.log(`🌐 Сайт:   http://localhost:${PORT}`);
    console.log(`🔧 Адмін:  http://localhost:${PORT}/admin  (пароль: CL34tyre)`);
    console.log(`🎬 Плеєр:  http://localhost:${PORT}/watch`);
    console.log(`💾 RAM:    ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB\n`);
  });

  server.keepAliveTimeout = 30000;
  server.headersTimeout = 35000;
  server.maxHeadersCount = 50;

  function shutdown(signal) {
    console.log(`\n[server] ${signal} received, shutting down...`);
    server.close(() => {
      console.log('[server] closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
  });
  
  process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED]', err?.message || err);
  });

}).catch((err) => {
  console.error('[DB] Помилка підключення до бази даних:', err);
  process.exit(1);
});
