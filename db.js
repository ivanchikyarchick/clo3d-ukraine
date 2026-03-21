const fs   = require('fs');
const path = require('path');
const DB   = path.join(__dirname, 'data', 'db.json');

const DEF = () => ({
  courses:  [],
  progress: {},
  stats: { botEvents:[], webEvents:[], totals:{messages:0,buyRequests:0,granted:0,videoViews:0} }
});

function load() {
  try {
    if (!fs.existsSync(DB)) { fs.mkdirSync(path.dirname(DB),{recursive:true}); save(DEF()); return DEF(); }
    const raw = JSON.parse(fs.readFileSync(DB,'utf8'));
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
    save(raw);
    return raw;
  } catch { return DEF(); }
}
function save(d) { fs.mkdirSync(path.dirname(DB),{recursive:true}); fs.writeFileSync(DB, JSON.stringify(d,null,2)); }
function get()   { return load(); }
function set(fn) { const d=load(); fn(d); save(d); return d; }

function connect() { return Promise.resolve(); } // noop for compatibility

function getCourse(cid) { return get().courses.find(c=>c.id===cid); }
function slugify(s) { return s.toLowerCase().replace(/[^a-zа-яё0-9]+/gi,'-').replace(/^-|-$/g,'')||Date.now().toString(); }
function newId()    { return Date.now().toString(36)+Math.random().toString(36).slice(2,5); }

function getProgress(uid, cid) {
  const d = get();
  return d.progress[`${uid}_${cid}`] || {watched:[],lastIdx:0,lastTs:null,completed:false,certIssuedAt:null};
}
function markWatched(uid, cid, idx) {
  set(d => {
    const key = `${uid}_${cid}`;
    if (!d.progress[key]) d.progress[key]={watched:[],lastIdx:idx,lastTs:Date.now(),completed:false,certIssuedAt:null};
    const p = d.progress[key];
    p.lastIdx=idx; p.lastTs=Date.now();
    if (!p.watched.includes(idx)) p.watched.push(idx);
    const course = d.courses.find(c=>c.id===cid);
    if (course && p.watched.length>=course.videos.length && !p.completed) {
      p.completed=true; p.certIssuedAt=Date.now();
    }
  });
  return getProgress(uid,cid);
}
function trackBot(type, userId, userName, data={}) {
  set(d => {
    if (!d.stats) d.stats={botEvents:[],webEvents:[],totals:{messages:0,buyRequests:0,granted:0,videoViews:0}};
    d.stats.botEvents.push({type,userId,userName:userName||'',data,ts:Date.now()});
    d.stats.totals.messages=(d.stats.totals.messages||0)+1;
    if(type==='buy_request') d.stats.totals.buyRequests=(d.stats.totals.buyRequests||0)+1;
    if(type==='granted')     d.stats.totals.granted=(d.stats.totals.granted||0)+1;
    if(type==='video_view')  d.stats.totals.videoViews=(d.stats.totals.videoViews||0)+1;
    if(d.stats.botEvents.length>2000) d.stats.botEvents=d.stats.botEvents.slice(-2000);
  });
}
function trackWeb(type, ip, reqPath, data={}) {
  set(d => {
    if (!d.stats) d.stats={botEvents:[],webEvents:[],totals:{}};
    d.stats.webEvents.push({type,ip:ip||'',path:reqPath||'',data,ts:Date.now()});
    if(d.stats.webEvents.length>2000) d.stats.webEvents=d.stats.webEvents.slice(-2000);
  });
}
module.exports = {connect,get,set,getCourse,slugify,newId,trackBot,trackWeb,getProgress,markWatched};