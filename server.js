const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');
const multer   = require('multer');
const https    = require('https');
const http     = require('http');
const db       = require('./db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CL34tyre';
const PORT           = process.env.PORT || 3000;
const BOT_TOKEN      = process.env.BOT_TOKEN || '8606783327:AAFlvRiAqhxLuxwtx_6l4glNeqlSS4x96AE';
const ADMIN_TG_ID    = parseInt(process.env.ADMIN_ID || '6590778330');
const SITE_URL       = process.env.SITE_URL || `https://fashionlab.com.ua`;

const app = express();
// On Render tmp dirs may not persist — only use for processing, never for storage
fs.mkdirSync('/tmp/vfl_tmp',   { recursive:true });
fs.mkdirSync('/tmp/vfl_certs', { recursive:true });

const uploadImport   = multer({ dest:'/tmp/vfl_tmp/' });
const uploadVideo    = multer({ dest:'/tmp/vfl_tmp/', limits:{fileSize:2*1024*1024*1024} });
const uploadMaterial = multer({ dest:'/tmp/vfl_tmp/', limits:{fileSize:200*1024*1024} });

// ── ADMIN SETTINGS (FOP, etc.) ────────────────────────────
// Get settings
app.get('/api/settings', adm, (req,res)=>{
  const d = db.get();
  res.json({ fop: d.settings?.fop || '' });
});
// Save settings
app.post('/api/settings', adm, (req,res)=>{
  const { fop } = req.body;
  db.set(d=>{ if(!d.settings) d.settings={}; if(fop!==undefined) d.settings.fop=fop; });
  res.json({ok:true});
});
// Public settings (FOP for bot payment message)
app.get('/api/settings/public',(req,res)=>{
  const d = db.get();
  res.json({ fop: d.settings?.fop || '' });
});

app.use(express.json());
app.use(express.urlencoded({ extended:true }));
app.use(express.static(path.join(__dirname,'public')));

// Session — use MongoDB store if available so sessions survive restarts
app.use(session({
  secret: process.env.SESSION_SECRET || 'vfl_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── SECURITY HEADERS ─────────────────────────────────────
app.use((req,res,next)=>{
  // Prevent hotlinking / embedding in external sites
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('X-Content-Type-Options','nosniff');
  // Block video loading from other origins
  if(req.path.startsWith('/api/video/')){
    const ref = req.headers.referer||'';
    const host = req.headers.host||'';
    // Allow same-origin only
    if(ref && !ref.includes(host)){
      res.status(403).send('Hotlinking not allowed'); return;
    }
    // No-cache, no-store for video segments
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma','no-cache');
    res.setHeader('X-Robots-Tag','noindex');
  }
  next();
});

app.use((req,res,next)=>{
  if (!req.path.startsWith('/api/') && req.method==='GET')
    db.trackWeb('visit', req.ip, req.path, { ua:(req.headers['user-agent']||'').slice(0,80) });
  next();
});

const adm = (req,res,next) => {
  // Перевіряємо сесію або Basic-auth header (для upload при втраченій сесії)
  if (req.session.isAdmin) { req.session.touch(); return next(); }
  // Fallback: перевіряємо пароль у header X-Admin-Password
  const hdr = req.headers['x-admin-password'];
  if (hdr && hdr === ADMIN_PASSWORD) { req.session.isAdmin = true; return next(); }
  res.status(401).json({ok:false,error:'Unauthorized'});
};

// ── AUTH ─────────────────────────────────────────────────
app.post('/api/login',(req,res)=>{
  if(req.body.password===ADMIN_PASSWORD){ req.session.isAdmin=true; res.json({ok:true}); }
  else { db.trackWeb('login_fail',req.ip,'/api/login'); res.status(401).json({ok:false,error:'Невірний пароль'}); }
});
app.post('/api/logout',(req,res)=>{ req.session.destroy(); res.json({ok:true}); });

// ── DASHBOARD ────────────────────────────────────────────
app.get('/api/dashboard', adm, (req,res)=>{
  const d=db.get(), s=d.stats||{}, now=Date.now();
  const botEvt=s.botEvents||[], webEvt=s.webEvents||[];
  const dayLabels=[],botByDay=[],webByDay=[];
  for(let i=6;i>=0;i--){
    const day=new Date(now-i*86400000);
    dayLabels.push(`${day.getDate()}.${day.getMonth()+1}`);
    const start=new Date(day).setHours(0,0,0,0), end=start+86400000;
    botByDay.push(botEvt.filter(e=>e.ts>=start&&e.ts<end).length);
    webByDay.push(webEvt.filter(e=>e.ts>=start&&e.ts<end).length);
  }
  const courses = d.courses || [];
  const evTypes={};
  botEvt.forEach(e=>{ evTypes[e.type]=(evTypes[e.type]||0)+1; });
  const t=s.totals||{};
  res.json({
    summary:{
      courses:   courses.length,
      buyers:    courses.reduce((s,c)=>s+(c.buyers?.length||0),0),
      pending:   courses.reduce((s,c)=>s+(c.pending?.length||0),0),
      videos:    courses.reduce((s,c)=>s+(c.videos?.length||0),0),
      buyRequests:  t.buyRequests||0, videoViews:t.videoViews||0,
      webVisits7:   webEvt.filter(e=>now-e.ts<7*86400000).length,
      messages:  t.messages||0, granted:t.granted||0,
    },
    charts:{ dayLabels,botByDay,webByDay },
    evTypes,
    recentBot: botEvt.slice(-30).reverse(),
    recentWeb: webEvt.slice(-30).reverse(),
    courses: d.courses||[],
  });
});

// ── PUBLIC: courses list & details ────────────────────────
app.get('/api/courses/public',(req,res)=>{
  const cs = (db.get().courses||[]).filter(c=>c.published).map(c=>({
    id:c.id, slug:c.slug, title:c.title, description:c.description,
    price:c.price, badge:c.badge, color:c.color||'#5b8dee',
    videoCount:c.videos?.length||0,
    freeAccess:!!c.freeAccess,
  }));
  res.json(cs);
});
app.get('/api/course/:slug/public',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.slug===req.params.slug&&x.published);
  if(!c){res.status(404).json({ok:false});return;}
  res.json({
    id:c.id, slug:c.slug, title:c.title, description:c.description,
    price:c.price, badge:c.badge, color:c.color,
    videoCount:c.videos?.length||0,
    // Що включає (бокс з ціною) — масив рядків
    includes: c.includes || [],
    // Карточки "Програма включає" — масив {title, desc}
    features: c.features || [],
    freeAccess: !!c.freeAccess,
  });
});

// ── PUBLIC: video list for player ─────────────────────────
app.get('/api/course/:cid/videos/public',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid);
  if(!c){res.status(404).json({ok:false});return;}
  res.json((c.videos||[]).map((v,i)=>({i,title:v.title,desc:v.desc,hasMaterials:!!(v.materials?.length)})));
});

// ── FREE COURSE: список відео без авторизації ─────────────
app.get('/api/course/:cid/videos/free',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid&&x.freeAccess);
  if(!c){res.status(403).json({ok:false});return;}
  res.json((c.videos||[]).map((v,i)=>({i,title:v.title,desc:v.desc,hasMaterials:!!(v.materials?.length)})));
});

// ── ADMIN PREVIEW — вхід без TG ID ───────────────────────
app.post('/api/admin/preview', adm, (req,res)=>{
  const d = db.get();
  const courses = (d.courses||[]).filter(c=>c.videos?.length);
  if (!courses.length) { res.status(404).json({ok:false,error:'Немає курсів з відео'}); return; }
  // Встановлюємо сесію як "адмін-перегляд"
  req.session.buyerId    = 0;       // спеціальний ID = 0 означає адмін-перегляд
  req.session.buyerName  = '👑 Адмін';
  req.session.isAdminPreview = true;
  res.json({ ok:true, name:'👑 Адмін', courses: courses.map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color})) });
});

// ── BUYER LOGIN ──────────────────────────────────────────
app.post('/api/buyer/login',(req,res)=>{
  const uid=parseInt(req.body.telegramId);
  if(!uid){res.status(400).json({ok:false,error:'Невірний ID'});return;}
  const d=db.get();
  // find all courses this buyer has access to
  const myCourses=(d.courses||[]).filter(c=>c.buyers?.some(b=>b.id===uid));
  if(!myCourses.length){res.status(403).json({ok:false,error:'Доступ не знайдено. Придбайте курс.'});return;}
  req.session.buyerId=uid;
  req.session.buyerName=myCourses[0].buyers.find(b=>b.id===uid)?.name||'Учень';
  res.json({ok:true,name:req.session.buyerName,courses:myCourses.map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color}))});
});
app.post('/api/buyer/logout',(req,res)=>{ req.session.buyerId=null; res.json({ok:true}); });
app.get('/api/buyer/me',(req,res)=>{
  // Адмін-перегляд
  if (req.session.isAdminPreview) {
    const courses = (db.get().courses||[]).filter(c=>c.videos?.length)
      .map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color}));
    res.json({ok:true, name:'👑 Адмін', courses});
    return;
  }
  const uid=req.session.buyerId;
  if(!uid){res.json({ok:false});return;}
  const d=db.get();
  const myCourses=(d.courses||[]).filter(c=>c.buyers?.some(b=>b.id===uid));
  res.json({ok:!!myCourses.length,name:req.session.buyerName,courses:myCourses.map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color}))});
});

// cert endpoint removed

// ── FREE COURSE: відео без авторизації ───────────────────
app.get('/api/video/free/:cid/:idx',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid);
  if(!c){res.status(404).send('Не знайдено');return;}
  if(!c.freeAccess){res.status(403).send('Доступ заборонено');return;}
  const idx=parseInt(req.params.idx);
  if(!c?.videos?.[idx]){res.status(404).send('Відео не знайдено');return;}
  streamTg(c.videos[idx].telegramFileId,req,res);
});

// ── FREE COURSE: список відео без авторизації ─────────────
app.get('/api/course/:cid/videos/free',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid&&x.freeAccess);
  if(!c){res.status(403).json({ok:false});return;}
  res.json((c.videos||[]).map((v,i)=>({i,title:v.title,desc:v.desc})));
});

// ── STREAM VIDEO — MAX SECURITY ───────────────────────────
app.get('/api/video/stream/:cid/:idx',(req,res)=>{
  const uid = req.session.buyerId;
  const isAdminOrPreview = req.session.isAdmin || req.session.isAdminPreview;
  if (!isAdminOrPreview) {
    if (uid === undefined || uid === null) { res.status(403).send('Доступ заборонено'); return; }
    const c = db.get().courses.find(x=>x.id===req.params.cid);
    if (!c?.buyers?.some(b=>b.id===uid)) { res.status(403).send('Доступ заборонено'); return; }
  }
  const c=db.get().courses.find(x=>x.id===req.params.cid);
  const idx=parseInt(req.params.idx);
  if(!c?.videos?.[idx]){res.status(404).send('Відео не знайдено');return;}
  streamTg(c.videos[idx].telegramFileId, req, res);
});

async function streamTg(fileId,req,res){
  try{
    const info=await fetchJson(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    if(!info.ok){res.status(500).send('Telegram error');return;}
    const fileSize=info.result.file_size||0;
    const url=`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
    const range=req.headers.range;
    if(range&&fileSize){
      const[s,e0]=range.replace(/bytes=/,'').split('-');
      const start=parseInt(s),end=e0?parseInt(e0):fileSize-1;
      res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${fileSize}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':'video/mp4','Content-Disposition':'inline'});
      proxyStream(url,res,{Range:`bytes=${start}-${end}`});
    } else {
      res.writeHead(200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Disposition':'inline',...(fileSize?{'Content-Length':fileSize}:{})});
      proxyStream(url,res);
    }
  } catch(e){ if(!res.headersSent)res.status(500).send(e.message); }
}
function fetchJson(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej);});}
function proxyStream(url,res,h={}){const mod=url.startsWith('https')?https:http;mod.get(url,{headers:h},up=>{up.pipe(res);up.on('error',()=>{if(!res.headersSent)res.end();});}).on('error',()=>{if(!res.headersSent)res.status(502).end();});}

// ── ADMIN: COURSES CRUD ───────────────────────────────────
app.get('/api/courses', adm, (req,res)=>res.json(db.get().courses||[]));

app.post('/api/courses', adm, (req,res)=>{
  const {title,description,price,badge,color,published,includes,features,freeAccess}=req.body;
  if(!title){res.status(400).json({ok:false,error:'Потрібна назва'});return;}
  const id=db.newId(), slug=db.slugify(title);
  db.set(d=>{ d.courses.push({id,slug,title,description:description||'',price:price||'',badge:badge||'',color:color||'#C8302A',published:!!published,freeAccess:!!freeAccess,createdAt:Date.now(),videos:[],buyers:[],pending:[],includes:includes||[],features:features||[]}); });
  res.json({ok:true,id,slug});
});

app.patch('/api/courses/:id', adm, (req,res)=>{
  db.set(d=>{
    const c=d.courses.find(x=>x.id===req.params.id);
    if(!c){return;}
    const {title,description,price,badge,color,published,includes,features,freeAccess}=req.body;
    if(title!==undefined){c.title=title; c.slug=db.slugify(title);}
    if(description!==undefined) c.description=description;
    if(price!==undefined)       c.price=price;
    if(badge!==undefined)       c.badge=badge;
    if(color!==undefined)       c.color=color;
    if(published!==undefined)   c.published=!!published;
    if(includes!==undefined)    c.includes=includes;
    if(features!==undefined)    c.features=features;
    if(freeAccess!==undefined)  c.freeAccess=!!freeAccess;
  });
  res.json({ok:true});
});

app.delete('/api/courses/:id', adm, (req,res)=>{
  db.set(d=>{ d.courses=d.courses.filter(c=>c.id!==req.params.id); });
  res.json({ok:true});
});

// ── ADMIN: VIDEO UPLOAD ───────────────────────────────────
// multer ПЕРШИЙ — парсить файл до перевірки сесії (велике відео)
app.post('/api/courses/:cid/videos', uploadVideo.single('video'), async(req,res)=>{
  // Перевіряємо авторизацію вже після того як multer прочитав файл
  if (!req.session.isAdmin) {
    const hdr = req.headers['x-admin-password'];
    if (!hdr || hdr !== ADMIN_PASSWORD) {
      if(req.file) try{fs.unlinkSync(req.file.path);}catch{}
      res.status(401).json({ok:false,error:'Unauthorized'}); return;
    }
    req.session.isAdmin = true;
  }
  const cid=req.params.cid;
  if(!req.file){res.status(400).json({ok:false,error:'Немає файлу'});return;}
  const title=req.body.title||`Урок ${(db.getCourse(cid)?.videos?.length||0)+1}`;
  const desc=req.body.desc||'';
  try{
    const FormData=require('form-data');
    const form=new FormData();
    const adminTgId = parseInt(process.env.ADMIN_ID || '6590778330');
    form.append('chat_id', adminTgId);
    form.append('caption',`📹 ${title}\n\n${desc}`);
    form.append('protect_content','true');
    form.append('video',fs.createReadStream(req.file.path),{filename:req.file.originalname||'video.mp4',contentType:req.file.mimetype||'video/mp4'});
    const tgRes=await postForm('/sendVideo',form);
    fs.unlinkSync(req.file.path);
    if(!tgRes.ok){res.status(500).json({ok:false,error:tgRes.description||'Telegram error'});return;}
    const entry={id:db.newId(),title,desc,telegramFileId:tgRes.result.video.file_id,size:tgRes.result.video.file_size||req.file.size||0,addedAt:Date.now()};
    db.set(d=>{ const c=d.courses.find(x=>x.id===cid); if(c){if(!c.videos)c.videos=[];c.videos.push(entry);} });
    res.json({ok:true,total:db.getCourse(cid)?.videos?.length});
  } catch(e){ try{fs.unlinkSync(req.file.path);}catch{} res.status(500).json({ok:false,error:e.message}); }
});

function postForm(endpoint,form){
  return new Promise((res,rej)=>{
    const h=form.getHeaders();
    const req2=https.request({hostname:'api.telegram.org',path:`/bot${BOT_TOKEN}${endpoint}`,method:'POST',headers:h},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});});
    req2.on('error',rej); form.pipe(req2);
  });
}

app.patch('/api/courses/:cid/videos/:idx', adm, (req,res)=>{
  db.set(d=>{ const c=d.courses.find(x=>x.id===req.params.cid); const v=c?.videos?.[parseInt(req.params.idx)]; if(v){if(req.body.title!==undefined)v.title=req.body.title;if(req.body.desc!==undefined)v.desc=req.body.desc;} });
  res.json({ok:true});
});
app.delete('/api/courses/:cid/videos/:idx', adm, (req,res)=>{
  db.set(d=>{ const c=d.courses.find(x=>x.id===req.params.cid); if(c)c.videos.splice(parseInt(req.params.idx),1); });
  res.json({ok:true});
});
app.post('/api/courses/:cid/videos/reorder', adm, (req,res)=>{
  const {from,to}=req.body;
  db.set(d=>{ const c=d.courses.find(x=>x.id===req.params.cid); if(c){const[item]=c.videos.splice(from,1);c.videos.splice(to,0,item);} });
  res.json({ok:true});
});

// ── ADMIN: VIDEO MATERIAL FILES ───────────────────────────
// Upload material file for a specific video
app.post('/api/courses/:cid/videos/:idx/materials', uploadMaterial.single('file'), async(req,res)=>{
  if (!req.session.isAdmin) {
    const hdr = req.headers['x-admin-password'];
    if (!hdr || hdr !== ADMIN_PASSWORD) {
      if(req.file) try{fs.unlinkSync(req.file.path);}catch{}
      res.status(401).json({ok:false,error:'Unauthorized'}); return;
    }
    req.session.isAdmin = true;
  }
  const cid = req.params.cid, idx = parseInt(req.params.idx);
  if(!req.file){ res.status(400).json({ok:false,error:'Немає файлу'}); return; }
  try{
    const FormData=require('form-data');
    const form=new FormData();
    const adminTgId = parseInt(process.env.ADMIN_ID || '6590778330');
    form.append('chat_id', adminTgId);
    const origName = req.file.originalname || 'material';
    form.append('caption', `📎 Матеріали до уроку: ${origName}`);
    form.append('document', fs.createReadStream(req.file.path), {filename: origName, contentType: req.file.mimetype||'application/octet-stream'});
    const tgRes = await postForm('/sendDocument', form);
    fs.unlinkSync(req.file.path);
    if(!tgRes.ok){ res.status(500).json({ok:false,error:tgRes.description||'Telegram error'}); return; }
    const fileId = tgRes.result.document.file_id;
    const fileName = origName;
    db.set(d=>{
      const c=d.courses.find(x=>x.id===cid);
      const v=c?.videos?.[idx];
      if(v){ if(!v.materials) v.materials=[]; v.materials.push({id:db.newId(),name:fileName,telegramFileId:fileId,size:tgRes.result.document.file_size||req.file.size||0,addedAt:Date.now()}); }
    });
    res.json({ok:true});
  } catch(e){ try{fs.unlinkSync(req.file.path);}catch{} res.status(500).json({ok:false,error:e.message}); }
});

// Delete material file from a video
app.delete('/api/courses/:cid/videos/:idx/materials/:mid', adm, (req,res)=>{
  db.set(d=>{
    const c=d.courses.find(x=>x.id===req.params.cid);
    const v=c?.videos?.[parseInt(req.params.idx)];
    if(v) v.materials=(v.materials||[]).filter(m=>m.id!==req.params.mid);
  });
  res.json({ok:true});
});

// Public: get materials list for a video (auth check for paid, free for freeAccess)
app.get('/api/course/:cid/videos/:idx/materials',(req,res)=>{
  const cid=req.params.cid, idx=parseInt(req.params.idx);
  const c=(db.get().courses||[]).find(x=>x.id===cid);
  if(!c){ res.status(404).json({ok:false}); return; }
  // Allow: admin, admin preview, or buyer of this course, or free course
  const uid=req.session.buyerId;
  const isAdmin=req.session.isAdmin||req.session.isAdminPreview;
  const isBuyer=c.buyers?.some(b=>b.id===uid);
  if(!isAdmin && !isBuyer && !c.freeAccess){ res.status(403).json({ok:false}); return; }
  const v=c.videos?.[idx];
  res.json((v?.materials||[]).map(m=>({id:m.id,name:m.name,size:m.size})));
});

// Download material file
app.get('/api/course/:cid/videos/:idx/materials/:mid/download',(req,res)=>{
  const cid=req.params.cid, idx=parseInt(req.params.idx), mid=req.params.mid;
  const c=(db.get().courses||[]).find(x=>x.id===cid);
  if(!c){ res.status(404).send('Не знайдено'); return; }
  const uid=req.session.buyerId;
  const isAdmin=req.session.isAdmin||req.session.isAdminPreview;
  const isBuyer=c.buyers?.some(b=>b.id===uid);
  if(!isAdmin && !isBuyer && !c.freeAccess){ res.status(403).send('Доступ заборонено'); return; }
  const v=c.videos?.[idx];
  const mat=(v?.materials||[]).find(m=>m.id===mid);
  if(!mat){ res.status(404).send('Файл не знайдено'); return; }
  // Proxy download from Telegram
  fetchJson(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${mat.telegramFileId}`)
    .then(info=>{
      if(!info.ok){ res.status(500).send('Telegram error'); return; }
      const url=`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
      res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(mat.name)}"`);
      res.setHeader('Content-Type','application/octet-stream');
      proxyStream(url,res);
    })
    .catch(e=>res.status(500).send(e.message));
});

// ── PROGRESS API ─────────────────────────────────────────
// Get progress for current buyer
app.get('/api/progress/:cid', (req,res)=>{
  if (req.session.isAdminPreview) { res.json({ok:true,watched:[],lastIdx:0,completed:false}); return; }
  const uid = req.session.buyerId || (req.session.isAdmin ? -1 : null);
  if (!uid) { res.status(403).json({ok:false}); return; }
  const p = db.getProgress(uid, req.params.cid);
  res.json({ ok:true, ...p });
});

app.post('/api/progress/:cid/:idx', (req,res)=>{
  if (req.session.isAdminPreview) { res.json({ok:true,watched:[],lastIdx:0,completed:false}); return; }
  const uid = req.session.buyerId;
  if (!uid) { res.status(403).json({ok:false}); return; }
  const cid = req.params.cid;
  const idx = parseInt(req.params.idx);
  // Verify buyer
  if (!db.get().courses.find(c=>c.id===cid)?.buyers?.some(b=>b.id===uid)) {
    res.status(403).json({ok:false}); return;
  }
  const prog = db.markWatched(uid, cid, idx);
  res.json({ ok:true, ...prog });
});

// All progress for admin
app.get('/api/progress/all/:cid', adm, (req,res)=>{
  const cid = req.params.cid;
  const c = db.getCourse(cid);
  if (!c) { res.status(404).json({ok:false}); return; }
  const d = db.get();
  const result = (c.buyers||[]).map(b => {
    const p = db.getProgress(b.id, cid);
    const pct = c.videos?.length ? Math.round(p.watched.length/c.videos.length*100) : 0;
    return { id:b.id, name:b.name, username:b.username, watched:p.watched.length, total:c.videos?.length||0, pct, completed:p.completed, lastTs:p.lastTs };
  });
  res.json(result);
});

// ── ADMIN NOTIFICATIONS ───────────────────────────────────
// Notify course buyers about new video
app.post('/api/notify/new-video/:cid', adm, async(req,res)=>{
  const cid = req.params.cid;
  const c = db.getCourse(cid);
  if (!c) { res.status(404).json({ok:false,error:'Курс не знайдено'}); return; }
  try {
    const { notifyNewContent } = require('./bot');
    const vidCount = c.videos?.length || 0;
    const lastVid  = c.videos?.[vidCount-1];
    const text = req.body.text ||
      `🎬 *Новий урок у курсі «${c.title}»!*\n\n` +
      (lastVid ? `📹 ${lastVid.title}\n\n` : '') +
      `Повернись та продовж навчання: /start`;
    const result = await notifyNewContent(cid, text);
    res.json({ ok:true, ...result });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Send reminders to inactive buyers
app.post('/api/notify/remind/:cid', adm, async(req,res)=>{
  try {
    const { sendReminders } = require('./bot');
    await sendReminders(req.params.cid);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── ADMIN: BUYERS ─────────────────────────────────────────
app.post('/api/courses/:cid/grant/:uid', adm, (req,res)=>{
  const uid=parseInt(req.params.uid), cid=req.params.cid;
  db.set(d=>{ const c=d.courses.find(x=>x.id===cid); if(!c)return; if(!c.buyers)c.buyers=[]; if(!c.buyers.some(b=>b.id===uid)){const p=c.pending?.find(b=>b.id===uid);c.buyers.push({id:uid,name:p?.name||'—',username:p?.username||'',grantedAt:Date.now()});} c.pending=(c.pending||[]).filter(b=>b.id!==uid); });
  try{const{grantAccess}=require('./bot');grantAccess(uid,'','',cid);}catch(e){try{require('./bot').bot.sendMessage(uid,'🎉 Доступ активовано! /start');}catch{}}
  res.json({ok:true});
});
app.post('/api/courses/:cid/revoke/:uid', adm, (req,res)=>{
  const uid=parseInt(req.params.uid);
  db.set(d=>{ const c=d.courses.find(x=>x.id===req.params.cid); if(c)c.buyers=(c.buyers||[]).filter(b=>b.id!==uid); });
  try{require('./bot').bot.sendMessage(uid,'😔 Ваш доступ відкликано.');}catch{}
  res.json({ok:true});
});
app.delete('/api/courses/:cid/pending/:uid', adm, (req,res)=>{
  const uid=parseInt(req.params.uid);
  db.set(d=>{ const c=d.courses.find(x=>x.id===req.params.cid); if(c)c.pending=(c.pending||[]).filter(b=>b.id!==uid); });
  try{require('./bot').bot.sendMessage(uid,'😔 Ваш запит відхилено.');}catch{}
  res.json({ok:true});
});

// ── BROADCAST ─────────────────────────────────────────────
app.post('/api/broadcast', adm, async(req,res)=>{
  const{message,cid}=req.body;
  if(!message){res.status(400).json({ok:false,error:'Немає тексту'});return;}
  try{ const r=await require('./bot').doBroadcast(message, cid||null); res.json({ok:true,...r}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── EXPORT ───────────────────────────────────────────────
app.get('/api/export/zip', adm, (req,res)=>{
  res.setHeader('Content-Disposition','attachment; filename="clo3d_backup.zip"');
  res.setHeader('Content-Type','application/zip');
  const arc=archiver('zip',{zlib:{level:9}});
  arc.on('error',e=>res.status(500).send(e.message));
  arc.pipe(res);
  arc.file('data/db.json',{name:'db.json'});
  const d=db.get();
  let bCsv='course,id,name,username,grantedAt\n';
  let vCsv='course,index,title,desc,fileId,size,addedAt\n';
  (d.courses||[]).forEach(c=>{
    (c.buyers||[]).forEach(b=>bCsv+=`"${c.title}",${b.id},"${b.name}","${b.username||''}","${new Date(b.grantedAt).toISOString()}"\n`);
    (c.videos||[]).forEach((v,i)=>vCsv+=`"${c.title}",${i+1},"${v.title||''}","${(v.desc||'').replace(/"/g,"'")}","${v.telegramFileId}",${v.size||0},"${new Date(v.addedAt).toISOString()}"\n`);
  });
  arc.append(bCsv,{name:'buyers.csv'});
  arc.append(vCsv,{name:'videos.csv'});
  arc.finalize();
});
app.get('/api/export/json', adm, (req,res)=>{ res.setHeader('Content-Disposition','attachment; filename="clo3d_db.json"'); res.json(db.get()); });
app.get('/api/export/stats', adm, (req,res)=>{
  const{stats}=db.get();
  const all=[...(stats.botEvents||[]),...(stats.webEvents||[])].sort((a,b)=>a.ts-b.ts);
  const csv='timestamp,source,type,user,path\n'+all.map(e=>`"${new Date(e.ts).toISOString()}","${e.userId?'bot':'web'}","${e.type}","${e.userId||e.ip||''}","${e.path||''}"`).join('\n');
  res.setHeader('Content-Disposition','attachment; filename="clo3d_stats.csv"');
  res.setHeader('Content-Type','text/csv');
  res.send(csv);
});

// ── IMPORT ───────────────────────────────────────────────
app.post('/api/import', adm, uploadImport.single('file'), (req,res)=>{
  if(!req.file){res.status(400).json({ok:false,error:'Немає файлу'});return;}
  try{
    const imp=JSON.parse(fs.readFileSync(req.file.path,'utf8'));
    db.set(d=>{
      if(imp.courses) for(const c of imp.courses) if(!d.courses.find(x=>x.id===c.id)) d.courses.push(c);
    });
    fs.unlinkSync(req.file.path);
    res.json({ok:true,imported:{courses:imp.courses?.length||0}});
  } catch(e){ try{fs.unlinkSync(req.file.path);}catch{} res.status(400).json({ok:false,error:e.message}); }
});

// ── PAGES ────────────────────────────────────────────────
app.get('/',   (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/course/:slug', (_,res)=>res.sendFile(path.join(__dirname,'public','course.html')));
app.get('/watch',  (_,res)=>res.sendFile(path.join(__dirname,'public','watch.html')));
app.get('/login',  (_,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/admin',  (_,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

module.exports = { app, PORT };
