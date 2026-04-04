/**
 * r2.js — Cloudflare R2 (S3-сумісний) для зберігання великих відео
 *
 * ENV:
 *   R2_ACCOUNT_ID  — Cloudflare Account ID
 *   R2_ACCESS_KEY  — R2 Access Key ID (з API токену)
 *   R2_SECRET_KEY  — R2 Secret Access Key
 *   R2_BUCKET      — Назва бакету
 */

const https = require('https');
const crypto = require('crypto');
const fs     = require('fs');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID  || '7f4d14bf10c6eb177000a84d3add3b62';
const ACCESS_KEY = process.env.R2_ACCESS_KEY  || 'f8eb8505e2d20e5a57dc0c682d3efa81';
const SECRET_KEY = process.env.R2_SECRET_KEY  || '43e32a11c21b600ef604e981290a036b3617f8ce00e639cd71eec3d622b0ece5';
const BUCKET     = process.env.R2_BUCKET      || 'fashionlab-videos';

const configured = !!(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && BUCKET);
const ENDPOINT   = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const REGION     = 'auto';

// ─── AWS Signature V4 ───────────────────────────────────────
function _hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function _sha256(data) {
  if (typeof data === 'string') data = Buffer.from(data);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function _signRequest(method, path, headers, isStreamingBody) {
  const now  = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const stamp = date.slice(0, 8);

  headers['x-amz-date']    = date;
  headers['x-amz-content-sha256'] = isStreamingBody ? 'UNSIGNED-PAYLOAD' : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const signedHeaders = Object.keys(headers).sort().map(k => k.toLowerCase()).join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k].trim()}\n`).join('');

  const canonicalRequest = [
    method, path, '', canonicalHeaders, signedHeaders, headers['x-amz-content-sha256']
  ].join('\n');

  const credentialScope = `${stamp}/${REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', date, credentialScope, _sha256(canonicalRequest)
  ].join('\n');

  const kDate    = _hmac('AWS4' + SECRET_KEY, stamp);
  const kRegion  = _hmac(kDate, REGION);
  const kService = _hmac(kRegion, 's3');
  const kSigning = _hmac(kService, 'aws4_request');
  const sig      = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
}

// ─── Upload ─────────────────────────────────────────────────

function uploadFile(key, filePath, contentType, size) {
  return new Promise((resolve, reject) => {
    if (!configured) return reject(new Error('R2 не налаштований'));

    const path   = `/${BUCKET}/${key}`;
    const stream = fs.createReadStream(filePath);
    const headers = {
      'Host':           new URL(ENDPOINT).hostname,
      'Content-Type':   contentType || 'video/mp4',
      'Content-Length': String(size),
    };
    _signRequest('PUT', path, headers, true);

    const req = https.request({
      hostname: new URL(ENDPOINT).hostname,
      path, method: 'PUT', headers,
      timeout: 300000, // 5 хв на з'єднання
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[R2] upload OK: ${key} (${size} bytes)`);
          resolve({ key, size });
        } else {
          reject(new Error(`R2 upload ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('R2 upload timeout')); });
    stream.pipe(req);
    stream.on('error', (e) => { req.destroy(); reject(e); });
  });
}

// ─── Streaming ──────────────────────────────────────────────

function streamFile(key, size, clientReq, clientRes) {
  return new Promise((resolve, reject) => {
    if (!configured) return reject(new Error('R2 не налаштований'));

    const path = `/${BUCKET}/${key}`;
    const range = clientReq.headers.range;
    const headers = { 'Host': new URL(ENDPOINT).hostname };
    if (range && size) headers['Range'] = range;
    _signRequest('GET', path, headers, false);

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    const gReq = https.request({
      hostname: new URL(ENDPOINT).hostname,
      path, method: 'GET', headers,
      timeout: 30000, // 30с на з'єднання
    }, gRes => {
      if (clientRes.destroyed) { gReq.destroy(); done(); return; }

      // Тільки безпечні заголовки (R2 повертає content-encoding/aws-chunked які ламають відео)
      const outHeaders = {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'inline',
        'Accept-Ranges': 'bytes',
      };
      if (gRes.headers['content-length']) outHeaders['Content-Length'] = gRes.headers['content-length'];
      if (gRes.headers['content-range'])  outHeaders['Content-Range']  = gRes.headers['content-range'];

      if (!clientRes.headersSent) {
        clientRes.writeHead(gRes.statusCode, outHeaders);
      }

      gRes.pipe(clientRes);
      gRes.on('end', () => done());
      gRes.on('error', (e) => { clientRes.destroy(); done(e); });
    });

    gReq.on('error', (e) => {
      console.error('[R2] stream error:', e.message);
      if (!clientRes.headersSent) try { clientRes.status(502).end('R2 stream error'); } catch { }
      done(e);
    });
    gReq.on('timeout', () => {
      console.error('[R2] stream timeout');
      gReq.destroy();
      if (!clientRes.headersSent) try { clientRes.status(504).end('R2 timeout'); } catch { }
      done(new Error('R2 stream timeout'));
    });

    // Якщо клієнт відключився — знищуємо запит до R2
    clientRes.on('close', () => {
      gReq.destroy();
      done();
    });

    gReq.end();
  });
}

// ─── Upload Buffer (for small files like db.json) ───────────

function uploadBuffer(key, buffer, contentType) {
  return new Promise((resolve, reject) => {
    if (!configured) return reject(new Error('R2 не налаштований'));
    
    // Ensure buffer is UTF-8 encoded if it's a string
    if (typeof buffer === 'string') {
      buffer = Buffer.from(buffer, 'utf8');
    }
    
    const urlPath = `/${BUCKET}/${key}`;
    const bodyHash = _sha256(buffer);
    const headers = {
      'Host':                    new URL(ENDPOINT).hostname,
      'Content-Type':            contentType || 'application/json; charset=utf-8',
      'Content-Length':          String(buffer.length),
      'x-amz-content-sha256':   bodyHash,
    };

    // Sign manually (bypass isStreamingBody flag — we have real hash)
    const now  = new Date();
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const stamp = date.slice(0, 8);
    headers['x-amz-date'] = date;

    const signedHeaders = Object.keys(headers).sort().map(k => k.toLowerCase()).join(';');
    const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k].trim()}\n`).join('');
    const canonicalRequest = ['PUT', urlPath, '', canonicalHeaders, signedHeaders, bodyHash].join('\n');
    const credentialScope = `${stamp}/${REGION}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, _sha256(canonicalRequest)].join('\n');
    const kDate    = _hmac('AWS4' + SECRET_KEY, stamp);
    const kRegion  = _hmac(kDate, REGION);
    const kService = _hmac(kRegion, 's3');
    const kSigning = _hmac(kService, 'aws4_request');
    const sig = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

    const req = https.request({
      hostname: new URL(ENDPOINT).hostname,
      path: urlPath, method: 'PUT', headers, timeout: 30000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`R2 uploadBuffer ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('R2 uploadBuffer timeout')); });
    req.write(buffer);
    req.end();
  });
}

// ─── Download (for db.json restore) ─────────────────────────

function downloadFile(key) {
  return new Promise((resolve) => {
    if (!configured) return resolve(null);
    const path = `/${BUCKET}/${key}`;
    const headers = { 'Host': new URL(ENDPOINT).hostname };
    _signRequest('GET', path, headers, false);
    const req = https.request({
      hostname: new URL(ENDPOINT).hostname,
      path, method: 'GET', headers, timeout: 15000,
    }, res => {
      if (res.statusCode === 404 || res.statusCode === 403) { res.resume(); return resolve(null); }
      res.setEncoding('utf8'); // Явно вказуємо UTF-8 кодування
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ─── Delete ─────────────────────────────────────────────────

function deleteFile(key) {
  return new Promise((resolve) => {
    if (!configured) return resolve();
    const path = `/${BUCKET}/${key}`;
    const headers = { 'Host': new URL(ENDPOINT).hostname };
    _signRequest('DELETE', path, headers, false);

    const req = https.request({
      hostname: new URL(ENDPOINT).hostname,
      path, method: 'DELETE', headers,
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
}

// ─── Helpers ────────────────────────────────────────────────

function makeKey(courseId, filename) {
  const safe = (filename || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `videos/${courseId}/${Date.now()}_${safe}`;
}

module.exports = { configured, uploadFile, uploadBuffer, downloadFile, streamFile, deleteFile, makeKey };
