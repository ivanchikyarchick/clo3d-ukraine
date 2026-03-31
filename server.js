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
const SITE_URL       = process.env.SITE_URL || 'https://fashionlab.com.ua';

const app = express();
fs.mkdirSync('/tmp/vfl_tmp', { recursive:true });

const uploadImport   = multer({ dest:'/tmp/vfl_tmp/' });
const uploadVideo    = multer({ dest:'/tmp/vfl_tmp/', limits:{fileSize:2*1024*1024*1024} });
const uploadMaterial = multer({ dest:'/tmp/vfl_tmp/', limits:{fileSize:200*1024*1024} });

app.use(express.json());
app.use(express.urlencoded({ extended:true }));
app.use(express.static(path.join(__dirname,'public')));
app.use(session({ secret: process.env.SESSION_SECRET||'vfl_secret_2025', resave:false, saveUninitialized:false, cookie:{maxAge:7*24*60*60*1000} }));

app.use((req,res,next)=>{
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.path.startsWith('/api/video/')){
    const ref=req.headers.referer||'', host=req.headers.host||'';
    if(ref&&!ref.includes(host)){res.status(403).send('Hotlinking not allowed');return;}
    res.setHeader('Cache-Control','no-store');
  }
  next();
});

app.use((req,res,next)=>{
  if(!req.path.startsWith('/api/')&&req.method==='GET')
    db.trackWeb('visit',req.ip,req.path,{ua:(req.headers['user-agent']||'').slice(0,80)});
  next();
});

const adm = (req,res,next)=>{
  if(req.session.isAdmin){req.session.touch();return next();}
  const hdr=req.headers['x-admin-password'];
  if(hdr&&hdr===ADMIN_PASSWORD){req.session.isAdmin=true;return next();}
  res.status(401).json({ok:false,error:'Unauthorized'});
};

// Settings
app.get('/api/settings', adm, (_,res)=>res.json({fop:db.get().settings?.fop||''}));
app.post('/api/settings', adm, (req,res)=>{
  const{fop}=req.body;
  db.set(d=>{if(!d.settings)d.settings={};if(fop!==undefined)d.settings.fop=fop;});
  res.json({ok:true});
});
app.get('/api/settings/public',(_,res)=>res.json({fop:db.get().settings?.fop||''}));

// Auth
app.post('/api/login',(req,res)=>{
  if(req.body.password===ADMIN_PASSWORD){req.session.isAdmin=true;res.json({ok:true});}
  else{db.trackWeb('login_fail',req.ip,'/api/login');res.status(401).json({ok:false,error:'Невірний пароль'});}
});
app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});

// Dashboard
app.get('/api/dashboard', adm, (req,res)=>{
  const d=db.get(),s=d.stats||{},now=Date.now();
  const bEvt=s.botEvents||[],wEvt=s.webEvents||[];
  const dayLabels=[],botByDay=[],webByDay=[];
  for(let i=6;i>=0;i--){
    const day=new Date(now-i*86400000);
    dayLabels.push(`${day.getDate()}.${day.getMonth()+1}`);
    const start=new Date(day).setHours(0,0,0,0),end=start+86400000;
    botByDay.push(bEvt.filter(e=>e.ts>=start&&e.ts<end).length);
    webByDay.push(wEvt.filter(e=>e.ts>=start&&e.ts<end).length);
  }
  const cs=d.courses||[],t=s.totals||{},evTypes={};
  bEvt.forEach(e=>{evTypes[e.type]=(evTypes[e.type]||0)+1;});
  res.json({
    summary:{courses:cs.length,buyers:cs.reduce((s,c)=>s+(c.buyers?.length||0),0),pending:cs.reduce((s,c)=>s+(c.pending?.length||0),0),videos:cs.reduce((s,c)=>s+(c.videos?.length||0),0),buyRequests:t.buyRequests||0,videoViews:t.videoViews||0,webVisits7:wEvt.filter(e=>now-e.ts<7*86400000).length,messages:t.messages||0,granted:t.granted||0},
    charts:{dayLabels,botByDay,webByDay},evTypes,
    recentBot:bEvt.slice(-30).reverse(),recentWeb:wEvt.slice(-30).reverse(),courses:cs,
  });
});

// Public courses
app.get('/api/courses/public',(req,res)=>res.json((db.get().courses||[]).filter(c=>c.published).map(c=>({id:c.id,slug:c.slug,title:c.title,description:c.description,price:c.price,badge:c.badge,color:c.color||'#5b8dee',videoCount:c.videos?.length||0,freeAccess:!!c.freeAccess}))));
app.get('/api/course/:slug/public',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.slug===req.params.slug&&x.published);
  if(!c){res.status(404).json({ok:false});return;}
  res.json({id:c.id,slug:c.slug,title:c.title,description:c.description,price:c.price,badge:c.badge,color:c.color,videoCount:c.videos?.length||0,includes:c.includes||[],features:c.features||[],freeAccess:!!c.freeAccess});
});

// Video lists
const vidList=(v,i)=>({i,title:v.title,desc:v.desc,hasMaterials:!!(v.materials?.length)});
app.get('/api/course/:cid/videos/public',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid);
  if(!c){res.status(404).json({ok:false});return;}
  res.json((c.videos||[]).map(vidList));
});
app.get('/api/course/:cid/videos/free',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid&&x.freeAccess);
  if(!c){res.status(403).json({ok:false});return;}
  res.json((c.videos||[]).map(vidList));
});

// Admin preview
app.post('/api/admin/preview', adm, (req,res)=>{
  const courses=(db.get().courses||[]).filter(c=>c.videos?.length);
  if(!courses.length){res.status(404).json({ok:false,error:'Немає курсів з відео'});return;}
  req.session.buyerId=0;req.session.buyerName='Адмін';req.session.isAdminPreview=true;
  res.json({ok:true,name:'Адмін',courses:courses.map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color}))});
});

// Buyer auth
app.post('/api/buyer/login',(req,res)=>{
  const uid=parseInt(req.body.telegramId);
  if(!uid){res.status(400).json({ok:false,error:'Невірний ID'});return;}
  const d=db.get();
  const myCourses=(d.courses||[]).filter(c=>c.buyers?.some(b=>b.id===uid));
  if(!myCourses.length){res.status(403).json({ok:false,error:'Доступ не знайдено. Придбайте курс.'});return;}
  req.session.buyerId=uid;
  req.session.buyerName=myCourses[0].buyers.find(b=>b.id===uid)?.name||'Учень';
  res.json({ok:true,name:req.session.buyerName,courses:myCourses.map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color}))});
});
app.post('/api/buyer/logout',(req,res)=>{req.session.buyerId=null;res.json({ok:true});});
app.get('/api/buyer/me',(req,res)=>{
  if(req.session.isAdminPreview){
    const courses=(db.get().courses||[]).filter(c=>c.videos?.length).map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color}));
    res.json({ok:true,name:'Адмін',courses});return;
  }
  const uid=req.session.buyerId;
  if(!uid){res.json({ok:false});return;}
  const myCourses=(db.get().courses||[]).filter(c=>c.buyers?.some(b=>b.id===uid));
  res.json({ok:!!myCourses.length,name:req.session.buyerName,courses:myCourses.map(c=>({id:c.id,slug:c.slug,title:c.title,color:c.color}))});
});

// Video streaming
app.get('/api/video/free/:cid/:idx',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid);
  if(!c||!c.freeAccess){res.status(403).send('Доступ заборонено');return;}
  const v=c.videos?.[parseInt(req.params.idx)];
  if(!v){res.status(404).send('Відео не знайдено');return;}
  streamTg(v.telegramFileId,req,res);
});
app.get('/api/video/stream/:cid/:idx',(req,res)=>{
  const isAdm=req.session.isAdmin||req.session.isAdminPreview;
  if(!isAdm){
    const uid=req.session.buyerId;
    if(!uid){res.status(403).send('Доступ заборонено');return;}
    const c=db.get().courses.find(x=>x.id===req.params.cid);
    if(!c?.buyers?.some(b=>b.id===uid)){res.status(403).send('Доступ заборонено');return;}
  }
  const c=db.get().courses.find(x=>x.id===req.params.cid);
  const v=c?.videos?.[parseInt(req.params.idx)];
  if(!v){res.status(404).send('Відео не знайдено');return;}
  streamTg(v.telegramFileId,req,res);
});

async function streamTg(fileId,req,res){
  try{
    const info=await fetchJson(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    if(!info.ok){res.status(500).send('Telegram error');return;}
    const fSize=info.result.file_size||0;
    const url=`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
    const range=req.headers.range;
    if(range&&fSize){
      const[s,e0]=range.replace(/bytes=/,'').split('-');
      const start=parseInt(s),end=e0?parseInt(e0):fSize-1;
      res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${fSize}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':'video/mp4','Content-Disposition':'inline'});
      proxyStream(url,res,{Range:`bytes=${start}-${end}`});
    }else{
      res.writeHead(200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Disposition':'inline',...(fSize?{'Content-Length':fSize}:{})});
      proxyStream(url,res);
    }
  }catch(e){if(!res.headersSent)res.status(500).send(e.message);}
}
function fetchJson(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej);});}
function proxyStream(url,res,h={}){const mod=url.startsWith('https')?https:http;mod.get(url,{headers:h},up=>{up.pipe(res);up.on('error',()=>{if(!res.headersSent)res.end();});}).on('error',()=>{if(!res.headersSent)res.status(502).end();});}

// Admin courses CRUD
app.get('/api/courses', adm, (req,res)=>res.json(db.get().courses||[]));
app.post('/api/courses', adm, (req,res)=>{
  const{title,description,price,badge,color,published,includes,features,freeAccess}=req.body;
  if(!title){res.status(400).json({ok:false,error:'Потрібна назва'});return;}
  const id=db.newId(),slug=db.slugify(title);
  db.set(d=>{d.courses.push({id,slug,title,description:description||'',price:price||'',badge:badge||'',color:color||'#C8302A',published:!!published,freeAccess:!!freeAccess,createdAt:Date.now(),videos:[],buyers:[],pending:[],includes:includes||[],features:features||[]});});
  res.json({ok:true,id,slug});
});
app.patch('/api/courses/:id', adm, (req,res)=>{
  db.set(d=>{
    const c=d.courses.find(x=>x.id===req.params.id);if(!c)return;
    const{title,description,price,badge,color,published,includes,features,freeAccess}=req.body;
    if(title!==undefined){c.title=title;c.slug=db.slugify(title);}
    if(description!==undefined)c.description=description;if(price!==undefined)c.price=price;
    if(badge!==undefined)c.badge=badge;if(color!==undefined)c.color=color;
    if(published!==undefined)c.published=!!published;if(includes!==undefined)c.includes=includes;
    if(features!==undefined)c.features=features;if(freeAccess!==undefined)c.freeAccess=!!freeAccess;
  });
  res.json({ok:true});
});
app.delete('/api/courses/:id', adm, (req,res)=>{db.set(d=>{d.courses=d.courses.filter(c=>c.id!==req.params.id);});res.json({ok:true});});

// Video upload
function checkAdm(req,res){
  if(req.session.isAdmin)return true;
  if(req.headers['x-admin-password']===ADMIN_PASSWORD){req.session.isAdmin=true;return true;}
  if(req.file)try{fs.unlinkSync(req.file.path);}catch{}
  res.status(401).json({ok:false,error:'Unauthorized'});return false;
}
function postForm(ep,form){
  return new Promise((res,rej)=>{
    const h=form.getHeaders();
    const r=https.request({hostname:'api.telegram.org',path:`/bot${BOT_TOKEN}${ep}`,method:'POST',headers:h},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});});
    r.on('error',rej);form.pipe(r);
  });
}

app.post('/api/courses/:cid/videos', uploadVideo.single('video'), async(req,res)=>{
  if(!checkAdm(req,res))return;
  const cid=req.params.cid;
  if(!req.file){res.status(400).json({ok:false,error:'Немає файлу'});return;}
  try{
    const FormData=require('form-data'),form=new FormData();
    form.append('chat_id',parseInt(process.env.ADMIN_ID||'6590778330'));
    form.append('caption',`${req.body.title||'Урок'}\n\n${req.body.desc||''}`);
    form.append('protect_content','true');
    form.append('video',fs.createReadStream(req.file.path),{filename:req.file.originalname||'video.mp4',contentType:req.file.mimetype||'video/mp4'});
    const tgRes=await postForm('/sendVideo',form);
    fs.unlinkSync(req.file.path);
    if(!tgRes.ok){res.status(500).json({ok:false,error:tgRes.description||'Telegram error'});return;}
    const title=req.body.title||`Урок ${(db.getCourse(cid)?.videos?.length||0)+1}`;
    db.set(d=>{const c=d.courses.find(x=>x.id===cid);if(c){if(!c.videos)c.videos=[];c.videos.push({id:db.newId(),title,desc:req.body.desc||'',telegramFileId:tgRes.result.video.file_id,size:tgRes.result.video.file_size||req.file.size||0,addedAt:Date.now()});}});
    res.json({ok:true,total:db.getCourse(cid)?.videos?.length});
  }catch(e){try{fs.unlinkSync(req.file.path);}catch{}res.status(500).json({ok:false,error:e.message});}
});
app.patch('/api/courses/:cid/videos/:idx', adm, (req,res)=>{
  db.set(d=>{const c=d.courses.find(x=>x.id===req.params.cid);const v=c?.videos?.[parseInt(req.params.idx)];if(v){if(req.body.title!==undefined)v.title=req.body.title;if(req.body.desc!==undefined)v.desc=req.body.desc;}});
  res.json({ok:true});
});
app.delete('/api/courses/:cid/videos/:idx', adm, (req,res)=>{
  db.set(d=>{const c=d.courses.find(x=>x.id===req.params.cid);if(c)c.videos.splice(parseInt(req.params.idx),1);});
  res.json({ok:true});
});
app.post('/api/courses/:cid/videos/reorder', adm, (req,res)=>{
  const{from,to}=req.body;
  db.set(d=>{const c=d.courses.find(x=>x.id===req.params.cid);if(c){const[item]=c.videos.splice(from,1);c.videos.splice(to,0,item);}});
  res.json({ok:true});
});

// Material files
app.post('/api/courses/:cid/videos/:idx/materials', uploadMaterial.single('file'), async(req,res)=>{
  if(!checkAdm(req,res))return;
  const cid=req.params.cid,idx=parseInt(req.params.idx);
  if(!req.file){res.status(400).json({ok:false,error:'Немає файлу'});return;}
  try{
    const FormData=require('form-data'),form=new FormData();
    const origName=req.file.originalname||'material';
    form.append('chat_id',parseInt(process.env.ADMIN_ID||'6590778330'));
    form.append('caption',`Матеріали: ${origName}`);
    form.append('document',fs.createReadStream(req.file.path),{filename:origName,contentType:req.file.mimetype||'application/octet-stream'});
    const tgRes=await postForm('/sendDocument',form);
    fs.unlinkSync(req.file.path);
    if(!tgRes.ok){res.status(500).json({ok:false,error:tgRes.description||'Telegram error'});return;}
    db.set(d=>{const c=d.courses.find(x=>x.id===cid);const v=c?.videos?.[idx];if(v){if(!v.materials)v.materials=[];v.materials.push({id:db.newId(),name:origName,telegramFileId:tgRes.result.document.file_id,size:tgRes.result.document.file_size||req.file.size||0,addedAt:Date.now()});}});
    res.json({ok:true});
  }catch(e){try{fs.unlinkSync(req.file.path);}catch{}res.status(500).json({ok:false,error:e.message});}
});
app.delete('/api/courses/:cid/videos/:idx/materials/:mid', adm, (req,res)=>{
  db.set(d=>{const c=d.courses.find(x=>x.id===req.params.cid);const v=c?.videos?.[parseInt(req.params.idx)];if(v)v.materials=(v.materials||[]).filter(m=>m.id!==req.params.mid);});
  res.json({ok:true});
});
app.get('/api/course/:cid/videos/:idx/materials',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid);
  if(!c){res.status(404).json({ok:false});return;}
  const uid=req.session.buyerId,isAdm=req.session.isAdmin||req.session.isAdminPreview;
  if(!isAdm&&!c.buyers?.some(b=>b.id===uid)&&!c.freeAccess){res.status(403).json({ok:false});return;}
  res.json((c.videos?.[parseInt(req.params.idx)]?.materials||[]).map(m=>({id:m.id,name:m.name,size:m.size})));
});
app.get('/api/course/:cid/videos/:idx/materials/:mid/download',(req,res)=>{
  const c=(db.get().courses||[]).find(x=>x.id===req.params.cid);
  if(!c){res.status(404).send('Не знайдено');return;}
  const uid=req.session.buyerId,isAdm=req.session.isAdmin||req.session.isAdminPreview;
  if(!isAdm&&!c.buyers?.some(b=>b.id===uid)&&!c.freeAccess){res.status(403).send('Доступ заборонено');return;}
  const mat=(c.videos?.[parseInt(req.params.idx)]?.materials||[]).find(m=>m.id===req.params.mid);
  if(!mat){res.status(404).send('Файл не знайдено');return;}
  fetchJson(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${mat.telegramFileId}`)
    .then(info=>{
      if(!info.ok){res.status(500).send('Telegram error');return;}
      res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(mat.name)}"`);
      res.setHeader('Content-Type','application/octet-stream');
      proxyStream(`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`,res);
    }).catch(e=>res.status(500).send(e.message));
});

// Progress
app.get('/api/progress/:cid',(req,res)=>{
  if(req.session.isAdminPreview){res.json({ok:true,watched:[],lastIdx:0,completed:false});return;}
  const uid=req.session.buyerId||(req.session.isAdmin?-1:null);
  if(!uid){res.status(403).json({ok:false});return;}
  res.json({ok:true,...db.getProgress(uid,req.params.cid)});
});
app.post('/api/progress/:cid/:idx',(req,res)=>{
  if(req.session.isAdminPreview){res.json({ok:true,watched:[],lastIdx:0,completed:false});return;}
  const uid=req.session.buyerId;
  if(!uid){res.status(403).json({ok:false});return;}
  const cid=req.params.cid;
  if(!db.get().courses.find(c=>c.id===cid)?.buyers?.some(b=>b.id===uid)){res.status(403).json({ok:false});return;}
  res.json({ok:true,...db.markWatched(uid,cid,parseInt(req.params.idx))});
});
app.get('/api/progress/all/:cid', adm, (req,res)=>{
  const c=db.getCourse(req.params.cid);
  if(!c){res.status(404).json({ok:false});return;}
  res.json((c.buyers||[]).map(b=>{
    const p=db.getProgress(b.id,req.params.cid);
    const pct=c.videos?.length?Math.round(p.watched.length/c.videos.length*100):0;
    return{id:b.id,name:b.name,username:b.username,watched:p.watched.length,total:c.videos?.length||0,pct,completed:p.completed,lastTs:p.lastTs};
  }));
});

// Notifications
app.post('/api/notify/new-video/:cid', adm, async(req,res)=>{
  const c=db.getCourse(req.params.cid);
  if(!c){res.status(404).json({ok:false,error:'Курс не знайдено'});return;}
  try{
    const{notifyNewContent}=require('./bot');
    const lastVid=c.videos?.[c.videos.length-1];
    const text=req.body.text||`Новий урок у «${c.title}»!\n\n${lastVid?`${lastVid.title}\n\n`:''}Повернись та продовж навчання: /start`;
    res.json({ok:true,...await notifyNewContent(req.params.cid,text)});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/notify/remind/:cid', adm, async(req,res)=>{
  try{await require('./bot').sendReminders(req.params.cid);res.json({ok:true});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});

// Buyers management
app.post('/api/courses/:cid/grant/:uid', adm, (req,res)=>{
  const uid=parseInt(req.params.uid),cid=req.params.cid;
  db.set(d=>{const c=d.courses.find(x=>x.id===cid);if(!c)return;if(!c.buyers)c.buyers=[];if(!c.buyers.some(b=>b.id===uid)){const p=c.pending?.find(b=>b.id===uid);c.buyers.push({id:uid,name:p?.name||'—',username:p?.username||'',grantedAt:Date.now()});}c.pending=(c.pending||[]).filter(b=>b.id!==uid);});
  try{require('./bot').grantAccess(uid,'','',cid);}catch(e){try{require('./bot').bot.sendMessage(uid,'Доступ активовано! /start');}catch{}}
  res.json({ok:true});
});
app.post('/api/courses/:cid/revoke/:uid', adm, (req,res)=>{
  const uid=parseInt(req.params.uid);
  db.set(d=>{const c=d.courses.find(x=>x.id===req.params.cid);if(c)c.buyers=(c.buyers||[]).filter(b=>b.id!==uid);});
  try{require('./bot').bot.sendMessage(uid,'Ваш доступ відкликано.');}catch{}
  res.json({ok:true});
});
app.delete('/api/courses/:cid/pending/:uid', adm, (req,res)=>{
  const uid=parseInt(req.params.uid);
  db.set(d=>{const c=d.courses.find(x=>x.id===req.params.cid);if(c)c.pending=(c.pending||[]).filter(b=>b.id!==uid);});
  try{require('./bot').bot.sendMessage(uid,'Ваш запит відхилено.');}catch{}
  res.json({ok:true});
});

// Broadcast
app.post('/api/broadcast', adm, async(req,res)=>{
  const{message,cid}=req.body;
  if(!message){res.status(400).json({ok:false,error:'Немає тексту'});return;}
  try{res.json({ok:true,...await require('./bot').doBroadcast(message,cid||null)});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});

// Export/Import
app.get('/api/export/zip', adm, (req,res)=>{
  res.setHeader('Content-Disposition','attachment; filename="fashionlab_backup.zip"');
  res.setHeader('Content-Type','application/zip');
  const arc=archiver('zip',{zlib:{level:9}});
  arc.on('error',e=>res.status(500).send(e.message));
  arc.pipe(res);
  arc.file('data/db.json',{name:'db.json'});
  const d=db.get();
  let bCsv='course,id,name,username,grantedAt\n',vCsv='course,index,title,desc,fileId,size,addedAt\n';
  (d.courses||[]).forEach(c=>{
    (c.buyers||[]).forEach(b=>bCsv+=`"${c.title}",${b.id},"${b.name}","${b.username||''}","${new Date(b.grantedAt).toISOString()}"\n`);
    (c.videos||[]).forEach((v,i)=>vCsv+=`"${c.title}",${i+1},"${v.title||''}","${(v.desc||'').replace(/"/g,"'")}","${v.telegramFileId}",${v.size||0},"${new Date(v.addedAt).toISOString()}"\n`);
  });
  arc.append(bCsv,{name:'buyers.csv'});arc.append(vCsv,{name:'videos.csv'});arc.finalize();
});
app.get('/api/export/json', adm, (req,res)=>{res.setHeader('Content-Disposition','attachment; filename="fashionlab_db.json"');res.json(db.get());});
app.get('/api/export/stats', adm, (req,res)=>{
  const{stats}=db.get();
  const all=[...(stats.botEvents||[]),...(stats.webEvents||[])].sort((a,b)=>a.ts-b.ts);
  const csv='timestamp,source,type,user,path\n'+all.map(e=>`"${new Date(e.ts).toISOString()}","${e.userId?'bot':'web'}","${e.type}","${e.userId||e.ip||''}","${e.path||''}"`).join('\n');
  res.setHeader('Content-Disposition','attachment; filename="fashionlab_stats.csv"');
  res.setHeader('Content-Type','text/csv');res.send(csv);
});
app.post('/api/import', adm, uploadImport.single('file'), (req,res)=>{
  if(!req.file){res.status(400).json({ok:false,error:'Немає файлу'});return;}
  try{
    const imp=JSON.parse(fs.readFileSync(req.file.path,'utf8'));
    db.set(d=>{if(imp.courses)for(const c of imp.courses)if(!d.courses.find(x=>x.id===c.id))d.courses.push(c);});
    fs.unlinkSync(req.file.path);
    res.json({ok:true,imported:{courses:imp.courses?.length||0}});
  }catch(e){try{fs.unlinkSync(req.file.path);}catch{}res.status(400).json({ok:false,error:e.message});}
});

// ── AUTO-SYNC (db.json → Telegram) ───────────────────────────────────────────
const SYNC_STATE_KEY = '__syncMsgId';          // зберігається у db.settings
let   syncEnabled   = false;                   // runtime toggle
let   syncDebounce  = null;
let   lastSyncHash  = '';

function dbJsonBuffer(){
  return Buffer.from(JSON.stringify(db.get(), null, 2), 'utf8');
}
function simpleHash(buf){
  let h=5381; for(const b of buf) h=((h<<5)+h)^b; return (h>>>0).toString(36);
}

async function tgApiJson(method, body){
  return new Promise((resolve,reject)=>{
    const payload=JSON.stringify(body);
    const req=https.request({hostname:'api.telegram.org',path:`/bot${BOT_TOKEN}/${method}`,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},r=>{
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} });
    });
    req.on('error',reject); req.write(payload); req.end();
  });
}

async function deleteSyncMessage(msgId){
  if(!msgId)return;
  try{ await tgApiJson('deleteMessage',{chat_id:ADMIN_ID,message_id:msgId}); }catch{}
}

async function sendDbToAdmin(reason){
  const buf = dbJsonBuffer();
  const hash = simpleHash(buf);
  if(hash===lastSyncHash && reason!=='startup') return; // нічого не змінилось
  lastSyncHash = hash;

  // видаляємо старе повідомлення якщо є
  const oldMsgId = db.get().settings?.[SYNC_STATE_KEY];
  if(oldMsgId) await deleteSyncMessage(oldMsgId);

  // відправляємо новий файл
  try{
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', ADMIN_ID);
    const ts = new Date().toLocaleString('uk',{timeZone:'Europe/Kyiv'});
    form.append('caption', `🗄 *db.json* — резервна копія\n📅 ${ts}\n📝 Причина: ${reason}`);
    form.append('parse_mode','Markdown');
    form.append('document', buf, {filename:'db.json', contentType:'application/json'});
    const res = await postForm('/sendDocument', form);
    if(res.ok){
      const newMsgId = res.result.message_id;
      db.set(d=>{ if(!d.settings)d.settings={}; d.settings[SYNC_STATE_KEY]=newMsgId; });
      console.log(`[sync] db.json sent to admin, msgId=${newMsgId}, reason=${reason}`);
    }else{
      console.warn('[sync] Telegram error:', res.description);
    }
  }catch(e){ console.warn('[sync] send error:', e.message); }
}

function scheduleSyncDebounced(reason='change'){
  if(!syncEnabled)return;
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(()=>sendDbToAdmin(reason), 3000); // чекаємо 3с після останньої зміни
}

// Патчимо db.set щоб відстежувати зміни
const _origDbSet = db.set.bind(db);
db.set = function(fn){
  _origDbSet(fn);
  scheduleSyncDebounced('зміна даних');
};

// API: отримати статус
app.get('/api/sync/status', adm, (_,res)=>res.json({enabled:syncEnabled}));

// API: увімк/вимк
app.post('/api/sync/toggle', adm, async(req,res)=>{
  syncEnabled = !!req.body.enabled;
  console.log(`[sync] autoSync=${syncEnabled}`);
  if(syncEnabled){
    await sendDbToAdmin('увімкнено синхронізацію');
  }
  res.json({ok:true,enabled:syncEnabled});
});

// API: примусова синхронізація
app.post('/api/sync/now', adm, async(req,res)=>{
  lastSyncHash=''; // форсуємо навіть якщо не було змін
  await sendDbToAdmin('ручна синхронізація');
  res.json({ok:true});
});

// При старті — автосинхронізація (якщо є попереднє збереження — теж оновимо)
setTimeout(async()=>{
  syncEnabled = true; // при старті завжди вмикаємо
  await sendDbToAdmin('startup');
  console.log('[sync] startup sync done');
}, 5000);

// Pages
app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/course/:slug',(_,res)=>res.sendFile(path.join(__dirname,'public','course.html')));
app.get('/watch',(_,res)=>res.sendFile(path.join(__dirname,'public','watch.html')));
app.get('/login',(_,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/admin',(_,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

module.exports = { app, PORT };
