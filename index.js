const { connect } = require('./db');
connect().then(() => {
  require('./bot');
  const { app, PORT } = require('./server');
  app.listen(PORT, () => {
    console.log(`\n🌸 Vitalia 3D Fashion Lab запущено`);
    console.log(`🌐 Сайт:   http://localhost:${PORT}`);
    console.log(`🔧 Адмін:  http://localhost:${PORT}/admin  (пароль: CL34tyre)`);
    console.log(`🎬 Плеєр:  http://localhost:${PORT}/watch`);
    console.log(`🤖 Bot:    @Clo3dua_bot\n`);
  });
});