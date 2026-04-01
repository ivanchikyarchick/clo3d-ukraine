/**
 * gdrive.js — Google Drive для зберігання відео >50 МБ
 *
 * ENV:
 *   GDRIVE_FOLDER_ID — ID папки на Google Drive куди зберігати відео
 *   GDRIVE_SA_JSON  — JSON сервісного акаунту (рядок або base64)
 *
 * Налаштування:
 *   1. Створіть проєкт на console.cloud.google.com
 *   2. Увімкніть Google Drive API
 *   3. Створіть Service Account, завантажте JSON ключ
 *   4. Поділіться папкою на Drive з service account email (як editor)
 *   5. GDRIVE_FOLDER_ID = ID цієї папки
 */

const https = require('https');
const fs    = require('fs');

const FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '';
let SA = null;
try {
  const raw = process.env.GDRIVE_SA_JSON || '';
  SA = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString());
} catch { SA = null; }

const configured = !!(FOLDER_ID && SA && SA.client_email && SA.private_key);

let _token = null;
let _tokenExp = 0;

function _jwtClaimset() {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(JSON.stringify({
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');
}

function _signRS256(data) {
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  return sign.sign(SA.private_key, 'base64url');
}

async function _getAccessToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimset = _jwtClaimset();
  const unsigned = `${header}.${claimset}`;
  const signature = _signRS256(unsigned);
  const jwt = `${unsigned}.${signature}`;

  const body = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;

  const result = await _httpsPost('oauth2.googleapis.com', '/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, body);

  _token = result.access_token;
  _tokenExp = Date.now() + (result.expires_in || 3600) * 1000;
  return _token;
}

function _httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method: 'POST', headers };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function _httpsRequest(hostname, path, method, headers, bodyStream) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (bodyStream) bodyStream.pipe(req);
    else req.end();
  });
}

/**
 * Resumable upload — підтримує файли будь-якого розміру
 * @param {string} filePath — шлях до локального файлу
 * @param {string} name    — ім'я файлу на Drive
 * @param {string} mime    — MIME тип
 * @param {number} size    — розмір файлу
 * @returns {Promise<{id: string, name: string, size: number}>}
 */
async function uploadFile(filePath, name, mime, size) {
  if (!configured) throw new Error('Google Drive не налаштований (ENV)');

  const token = await _getAccessToken();

  // Крок 1: Ініціюємо resumable upload
  const meta = JSON.stringify({ name, parents: [FOLDER_ID] });
  const initRes = await _httpsRequest('www.googleapis.com', '/upload/drive/v3/files?uploadType=resumable', 'POST', {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(meta),
  }, null);

  // Додаємо body для init запиту
  // Перероблюємо через https.request з body
  const uploadUrl = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: '/upload/drive/v3/files?uploadType=resumable',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(meta),
      },
    }, res => {
      const loc = res.headers['location'];
      if (res.statusCode === 200 && loc) { resolve(loc); }
      else {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => reject(new Error(`Drive init ${res.statusCode}: ${d.slice(0, 200)}`)));
      }
    });
    req.on('error', reject);
    req.write(meta);
    req.end();
  });

  // Крок 2: Завантажуємо файл
  const url = new URL(uploadUrl);
  const result = await new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Length': size,
        'Content-Type': mime || 'video/mp4',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad Drive response')); }
        } else {
          reject(new Error(`Drive upload ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    fileStream.pipe(req);
  });

  return { id: result.id, name: result.name, size };
}

/**
 * Стрімити файл з Google Drive (з Range support)
 * @param {string} fileId
 * @param {number} fileSize
 * @param {object} req — Express request
 * @param {object} res — Express response
 */
async function streamFile(fileId, fileSize, req, res) {
  if (!configured) throw new Error('Google Drive не налаштований');

  const token = await _getAccessToken();
  const range = req.headers.range;

  const headers = {
    'Authorization': `Bearer ${token}`,
  };

  if (range) {
    headers['Range'] = range;
  }

  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);

  await new Promise((resolve, reject) => {
    const gReq = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers,
    }, gRes => {
      res.writeHead(gRes.statusCode, {
        ...gRes.headers,
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'inline',
        'Access-Control-Allow-Origin': '*',
      });
      gRes.pipe(res);
      gRes.on('end', resolve);
      gRes.on('error', reject);
    });
    gReq.on('error', reject);
    gReq.end();
  });
}

/**
 * Видалити файл з Google Drive
 * @param {string} fileId
 */
async function deleteFile(fileId) {
  if (!configured) return;
  try {
    const token = await _getAccessToken();
    await _httpsRequest('www.googleapis.com', `/drive/v3/files/${fileId}`, 'DELETE', {
      'Authorization': `Bearer ${token}`,
    }, null);
  } catch { }
}

module.exports = { configured, uploadFile, streamFile, deleteFile };
