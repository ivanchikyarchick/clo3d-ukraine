/**
 * b2.js — Мінімальний S3-сумісний клієнт для Backblaze B2
 * 
 * Не потребує зовнішніх залежностей — використовує вбудований https.
 * Оптимізовано для 512MB RAM: стрімінг без буферизації всього файлу.
 * 
 * ENV:
 *   B2_ENDPOINT   — https://s3.REGION.backblazeb2.com
 *   B2_BUCKET     — назва бакету
 *   B2_KEY_ID     — applicationKeyId
 *   B2_APP_KEY    — applicationKey
 */

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const fs     = require('fs');

const B2_ENDPOINT = process.env.B2_ENDPOINT  || '';
const B2_BUCKET   = process.env.B2_BUCKET    || '';
const B2_KEY_ID   = process.env.B2_KEY_ID    || '';
const B2_APP_KEY  = process.env.B2_APP_KEY   || '';

const configured = !!(B2_ENDPOINT && B2_BUCKET && B2_KEY_ID && B2_APP_KEY);

function _hmacSha256(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function _sha256Hex(data) {
  if (typeof data === 'string') data = Buffer.from(data);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function _amzDate() {
  const d = new Date();
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
}

function _dateStamp(d) { return d.slice(0, 8); }

function _signHeaders(method, path, headers, bodyStream) {
  const service = 's3';
  const region  = B2_ENDPOINT.match(/s3\.([^.]+)\./)?.[1] || 'us-west-004';
  const date    = _amzDate();
  const stamp   = _dateStamp(date);

  headers['x-amz-date']    = date;
  headers['x-amz-content-sha256'] = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k].trim()}\n`).join('');

  const canonicalRequest = [
    method, path, '', canonicalHeaders, signedHeaders, 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'
  ].join('\n');

  const credentialScope = `${stamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', date, credentialScope, _sha256Hex(canonicalRequest)
  ].join('\n');

  const kDate    = _hmacSha256('AWS4' + B2_APP_KEY, stamp);
  const kRegion  = _hmacSha256(kDate, region);
  const kService = _hmacSha256(kRegion, service);
  const kSigning = _hmacSha256(kService, 'aws4_request');
  const sig      = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${B2_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return headers;
}

/**
 * Завантажити файл з диску в B2 (потокове, без буферизації всього файлу)
 * @param {string} key      — ключ (шлях) у бакеті
 * @param {string} filePath — локальний шлях до файлу
 * @param {string} contentType — MIME тип
 * @param {number} size     — розмір файлу
 * @returns {Promise<{key: string, size: number}>}
 */
function uploadFile(key, filePath, contentType, size) {
  return new Promise((resolve, reject) => {
    if (!configured) return reject(new Error('B2 не налаштований (відсутні ENV змінні)'));

    const parsed = new URL(B2_ENDPOINT);
    const path = `/${B2_BUCKET}/${key}`;
    const stream = fs.createReadStream(filePath);

    const headers = {
      'Host':          parsed.hostname,
      'Content-Type':  contentType || 'application/octet-stream',
      'Content-Length': String(size),
    };
    _signHeaders('PUT', path, headers);

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path,
      method:   'PUT',
      headers,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ key, size });
        } else {
          reject(new Error(`B2 upload ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    stream.pipe(req);
    stream.on('error', reject);
  });
}

/**
 * Стрімити файл з B2 у Response (з підтримкою Range requests)
 * @param {string}   key — ключ у бакеті
 * @param {number}   size — розмір файлу
 * @param {object}   req — Express request (для Range header)
 * @param {object}   res — Express response
 */
function streamFile(key, size, req, res) {
  return new Promise((resolve, reject) => {
    if (!configured) return reject(new Error('B2 не налаштований'));

    const parsed = new URL(B2_ENDPOINT);
    const path   = `/${B2_BUCKET}/${key}`;
    const range  = req.headers.range;

    const headers = {
      'Host': parsed.hostname,
    };

    if (range && size) {
      const [s, e0] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(s);
      const end   = e0 ? parseInt(e0) : Math.min(start + 4 * 1024 * 1024, size - 1);

      headers['Range'] = `bytes=${start}-${end}`;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   'video/mp4',
        'Content-Disposition': 'inline',
      });
    } else {
      res.writeHead(200, {
        'Content-Type':   'video/mp4',
        'Accept-Ranges':  'bytes',
        'Content-Disposition': 'inline',
        ...(size ? { 'Content-Length': size } : {}),
      });
    }

    _signHeaders('GET', path, headers);

    const mod = parsed.protocol === 'https:' ? https : http;
    const b2req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path,
      method:   'GET',
      headers,
    }, b2res => {
      res.writeHead(b2res.statusCode, b2res.headers);
      b2res.pipe(res);
      b2res.on('end', resolve);
      b2res.on('error', reject);
    });
    b2req.on('error', () => { if (!res.headersSent) res.status(502).end(); reject; });
    b2req.end();
  });
}

/**
 * Видалити файл з B2
 * @param {string} key
 * @returns {Promise<void>}
 */
function deleteFile(key) {
  return new Promise((resolve, reject) => {
    if (!configured) return resolve();
    const parsed = new URL(B2_ENDPOINT);
    const path = `/${B2_BUCKET}/${key}`;
    const headers = { 'Host': parsed.hostname };
    _signHeaders('DELETE', path, headers);

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path,
      method:   'DELETE',
      headers,
    }, res => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Генерувати ключ для відео
 */
function makeKey(courseId, filename) {
  const ts = Date.now();
  const safe = (filename || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `videos/${courseId}/${ts}_${safe}`;
}

module.exports = {
  configured,
  uploadFile,
  streamFile,
  deleteFile,
  makeKey,
  TG_MAX_SIZE: 50 * 1024 * 1024, // 50 МБ — ліміт Telegram Bot API
};
