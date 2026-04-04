// Monobank: вебхук (raw body) окремо від JSON API — див. server.js порядок middleware.
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const db = require('./db');

const SITE_URL = process.env.SITE_URL || 'https://fashionlab.com.ua';
const MONO_WEBHOOK_STRICT = process.env.MONO_WEBHOOK_STRICT === '1';
const WEBHOOK_LOG_MAX = Math.min(parseInt(process.env.MONO_WEBHOOK_LOG_MAX || '120', 10) || 120, 500);

// ─── Fetch invoice status from Monobank ──────────────────────────────────────
async function fetchInvoiceStatus(invoiceId) {
  const token = getMonoToken();
  if (!token || !invoiceId) return null;
  
  try {
    const response = await fetch(
      `https://api.monobank.ua/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`,
      { headers: { 'X-Token': token } }
    );
    const data = await response.json();
    if (response.ok && data.invoiceId) {
      return data;
    }
    console.warn('[monobank] Invoice status fetch failed:', data.errText || data.errCode);
    return null;
  } catch (e) {
    console.error('[monobank] Invoice status error:', e.message);
    return null;
  }
}

// ─── Simple email via SMTP (nodemailer) ──────────────────────────────────────
async function sendPaymentEmail(toEmail, courseTitle, courseSlug, invoiceId) {
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: true,
      auth: {
        user: process.env.SMTP_USER || 'vitaliia.3dlab@gmail.com',
        pass: process.env.SMTP_PASS || 'zvlegbhjmemkvsef',
      },
    });
    
    const watchUrl = `${SITE_URL}/watch?course=${courseSlug}`;
    
    // Fetch payment receipt details
    let receiptHtml = '';
    if (invoiceId) {
      const invoiceData = await fetchInvoiceStatus(invoiceId);
      if (invoiceData && invoiceData.paymentInfo) {
        const amount = ((invoiceData.amount || 0) / 100).toFixed(2);
        const date = invoiceData.createdDate ? new Date(invoiceData.createdDate).toLocaleString('uk-UA') : '—';
        const card = invoiceData.paymentInfo.maskedPan || '—';
        const approvalCode = invoiceData.paymentInfo.approvalCode || '—';
        const reference = invoiceData.reference || '—';
        
        receiptHtml = `
          <div style="margin-top:32px;padding-top:24px;border-top:1px solid #2A2020">
            <h4 style="color:#C8302A;margin-bottom:16px">Квитанція про оплату</h4>
            <table style="width:100%;color:#E8D8D5;font-size:14px">
              <tr><td style="padding:6px 0;color:#9A8A8A">Сума:</td><td style="padding:6px 0;text-align:right">${amount} грн</td></tr>
              <tr><td style="padding:6px 0;color:#9A8A8A">Дата:</td><td style="padding:6px 0;text-align:right">${date}</td></tr>
              <tr><td style="padding:6px 0;color:#9A8A8A">Картка:</td><td style="padding:6px 0;text-align:right">${card}</td></tr>
              <tr><td style="padding:6px 0;color:#9A8A8A">Код авторизації:</td><td style="padding:6px 0;text-align:right">${approvalCode}</td></tr>
              <tr><td style="padding:6px 0;color:#9A8A8A">Референс:</td><td style="padding:6px 0;text-align:right">${reference}</td></tr>
            </table>
          </div>
        `;
      }
    }
    
    await transporter.sendMail({
      from: `"Vitaliia 3D Fashion Lab" <${process.env.SMTP_USER || 'vitaliia.3dlab@gmail.com'}>`,
      to: toEmail,
      subject: `✅ Оплата підтверджена — ${courseTitle}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#080404;color:#F5F2F0;padding:32px;border-radius:12px">
          <h2 style="color:#C8302A;margin-bottom:8px">Vitaliia 3D Fashion Lab</h2>
          <p style="color:#9A8A8A;font-size:13px;margin-bottom:24px">CLO 3D українською</p>
          <h3 style="margin-bottom:16px">Дякуємо за оплату!</h3>
          <p>Ваш доступ до курсу <strong style="color:#E8D8D5">${courseTitle}</strong> активовано.</p>
          <p style="margin-top:16px">Для перегляду курсу натисніть кнопку:</p>
          <a href="${watchUrl}" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#C8302A;color:#fff;text-decoration:none;border-radius:100px;font-weight:700">Почати перегляд</a>
          ${receiptHtml}
          <p style="margin-top:24px;color:#9A8A8A;font-size:12px">Якщо у вас виникли питання — пишіть на vitaliia.3dlab@gmail.com</p>
        </div>
      `,
    });
    console.log('[email] Sent payment confirmation to:', toEmail);
  } catch (e) {
    console.warn('[email] Failed to send:', e.message);
  }
}

function getMonoToken() {
  const MONOBANK_TOKEN = process.env.MONOBANK_TOKEN || '';
  const settings = db.get().settings || {};
  return MONOBANK_TOKEN || settings.monoToken || '';
}

function pushWebhookLog(entry) {
  db.set(d => {
    if (!d.webhookLogs) d.webhookLogs = [];
    d.webhookLogs.push({ ...entry, ts: Date.now() });
    if (d.webhookLogs.length > WEBHOOK_LOG_MAX) {
      d.webhookLogs = d.webhookLogs.slice(-WEBHOOK_LOG_MAX);
    }
  });
}

function verifyMonoSignature(pubKeyBase64, body, signatureBase64) {
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    const pemKey = `-----BEGIN PUBLIC KEY-----\n${pubKeyBase64}\n-----END PUBLIC KEY-----`;
    const verifier = crypto.createVerify('ECDSA-SHA256');
    verifier.update(body);
    return verifier.verify(pemKey, signature);
  } catch (e) {
    console.error('[monobank] verify error:', e.message);
    return false;
  }
}

let _monoPubKey = null;
let _monoPubKeyTs = 0;
const MONO_PUBKEY_TTL = 24 * 60 * 60 * 1000;

async function getMonoPubKey() {
  const token = getMonoToken();
  if (!token) return null;
  if (_monoPubKey && Date.now() - _monoPubKeyTs < MONO_PUBKEY_TTL) return _monoPubKey;

  try {
    const response = await fetch('https://api.monobank.ua/api/merchant/pubkey', {
      headers: { 'X-Token': token },
    });
    const data = await response.json();
    if (data.key) {
      _monoPubKey = data.key;
      _monoPubKeyTs = Date.now();
      console.log('[monobank] Public key refreshed');
    }
  } catch (e) {
    console.error('[monobank] pubkey fetch error:', e.message);
  }
  return _monoPubKey;
}

/** Лише вебхук — монтується ДО express.json() */
function mountMonopayWebhook(webhookRouter) {
  webhookRouter.post('/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-sign'];
    const body = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');

    pushWebhookLog({
      type: 'webhook_in',
      hasSign: !!signature,
      bodyLen: body.length,
      invoiceId: null,
    });

    if (!signature) {
      console.error('[monobank] No X-Sign header');
      pushWebhookLog({ type: 'webhook_reject', reason: 'no_signature' });
      res.status(400).json({ error: 'No signature' });
      return;
    }

    const pubKey = await getMonoPubKey();
    if (!pubKey) {
      console.error('[monobank] No pubkey');
      res.status(500).json({ error: 'No pubkey' });
      return;
    }

    const isValid = verifyMonoSignature(pubKey, body, signature);
    console.log('[monobank] Webhook signature valid:', isValid);

    if (!isValid && MONO_WEBHOOK_STRICT) {
      pushWebhookLog({ type: 'webhook_reject', reason: 'bad_signature' });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
    if (!isValid) {
      console.warn('[monobank] Invalid signature (MONO_WEBHOOK_STRICT=0 — обробляємо для дев)');
    }

    let payment;
    try {
      payment = JSON.parse(body);
    } catch (e) {
      console.error('[monobank] Webhook JSON parse error:', e.message);
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }

    pushWebhookLog({
      type: 'webhook_parsed',
      invoiceId: payment.invoiceId,
      status: payment.status,
      amount: payment.amount,
      modifiedDate: payment.modifiedDate,
    });

    const d0 = db.get();
    const pending = d0.pendingPayments?.find(p => p.invoiceId === payment.invoiceId);

    db.set(d => {
      if (!d.payments) d.payments = [];
      const idx = d.payments.findIndex(p => p.invoiceId === payment.invoiceId);
      const prev = idx >= 0 ? d.payments[idx] : {};
      const paymentData = {
        ...prev,
        invoiceId: payment.invoiceId,
        status: payment.status,
        amount: payment.amount,
        ccy: payment.ccy,
        finalAmount: payment.finalAmount,
        reference: payment.reference,
        destination: payment.destination,
        createdDate: payment.createdDate,
        modifiedDate: payment.modifiedDate,
        paymentInfo: payment.paymentInfo,
        webhookReceivedAt: Date.now(),
      };
      if (pending?.buyerId != null) {
        paymentData.buyerId = pending.buyerId;
        paymentData.courseId = pending.courseId;
      }
      if (idx >= 0) d.payments[idx] = paymentData;
      else d.payments.push(paymentData);
    });

    if (payment.status === 'success') {
      console.log('[monobank] Payment SUCCESS:', payment.invoiceId, payment.amount);
      let emailData = null;
      db.set(d => {
        const p = d.pendingPayments?.find(x => x.invoiceId === payment.invoiceId);
        if (p && p.buyerId && p.courseId) {
          const c = d.courses.find(x => x.id === p.courseId);
          if (c && !c.buyers?.some(b => parseInt(b.id, 10) === parseInt(p.buyerId, 10))) {
            if (!c.buyers) c.buyers = [];
            c.buyers.push({ id: parseInt(p.buyerId, 10), name: '—', grantedAt: Date.now() });
            console.log('[monobank] Access granted buyer', p.buyerId, 'course', p.courseId);
          }
          const buyer = d.buyerAccounts?.find(a => a.id === parseInt(p.buyerId, 10));
          const email = buyer?.email || buyer?.username;
          if (email && c) emailData = { email, title: c.title, slug: c.slug };
        }
        d.pendingPayments = (d.pendingPayments || []).filter(x => x.invoiceId !== payment.invoiceId);
      });
      if (emailData) {
        setImmediate(() => sendPaymentEmail(emailData.email, emailData.title, emailData.slug, payment.invoiceId));
      }
    }

    res.json({ ok: true });
  });
}

/** JSON API — викликати ПІСЛЯ express.json() та session */
function mountMonopayApi(app) {
  app.post('/api/payment/create', async (req, res) => {
    const token = getMonoToken();
    if (!token) {
      res.status(500).json({ ok: false, error: 'Токен Monobank не налаштований (MONOBANK_TOKEN або monoToken в адмінці)' });
      return;
    }

    const { amount, description, courseId, buyerId, redirectUrl } = req.body || {};

    const buyerNum = buyerId != null ? parseInt(buyerId, 10) : NaN;
    if (!buyerNum || Number.isNaN(buyerNum)) {
      res.status(400).json({ ok: false, error: 'Потрібен buyerId (увійдіть у акаунт)' });
      return;
    }

    const amountNum = Math.round(Number(amount));
    if (!Number.isFinite(amountNum) || amountNum < 100) {
      res.status(400).json({ ok: false, error: 'Невалідна сума (мінімум 100 коп. = 1 грн)' });
      return;
    }

    const reference = `course_${courseId || 'order'}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

    const invoiceData = {
      amount: amountNum,
      ccy: 980,
      merchantPaymInfo: {
        reference,
        destination: (description || 'Оплата').slice(0, 255),
      },
      redirectUrl: redirectUrl || `${SITE_URL}/payment-result`,
      webHookUrl: `${SITE_URL}/api/payment/webhook`,
      validity: 3600,
      paymentType: 'debit',
    };

    try {
      const response = await fetch('https://api.monobank.ua/api/merchant/invoice/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Token': token,
        },
        body: JSON.stringify(invoiceData),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || result.errCode) {
        console.error('[monobank] create error:', response.status, result);
        res.status(response.status >= 400 ? response.status : 502).json({
          ok: false,
          error: result.errText || result.errCode || result.message || 'Не вдалося створити платіж',
          details: result,
        });
        return;
      }

      if (buyerNum) {
        db.set(d => {
          if (!d.pendingPayments) d.pendingPayments = [];
          d.pendingPayments.push({
            invoiceId: result.invoiceId,
            buyerId: buyerNum,
            courseId: courseId || null,
            amount: amountNum,
            createdAt: Date.now(),
          });
        });
      }

      res.json({
        ok: true,
        invoiceId: result.invoiceId,
        pageUrl: result.pageUrl,
        amount: amountNum,
      });
    } catch (e) {
      console.error('[monobank] request error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/payment/status', async (req, res) => {
    const token = getMonoToken();
    if (!token) {
      res.status(500).json({ ok: false, error: 'Monobank не налаштований' });
      return;
    }

    const invoiceId = req.query.invoiceId;
    if (!invoiceId) {
      res.status(400).json({ ok: false, error: 'invoiceId required' });
      return;
    }

    try {
      const response = await fetch(
        `https://api.monobank.ua/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`,
        { headers: { 'X-Token': token } }
      );

      const result = await response.json().catch(() => ({}));

      if (response.ok && result.invoiceId) {
        res.json({
          ok: true,
          status: result.status,
          amount: result.amount,
          invoiceId: result.invoiceId,
        });
      } else {
        res.status(400).json({
          ok: false,
          error: result.errText || result.errCode || 'Status check failed',
        });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

function grantCourseAccess(buyerId, courseId) {
  db.set(d => {
    const c = d.courses.find(x => x.id === courseId);
    if (c && !c.buyers?.some(b => b.id === parseInt(buyerId, 10))) {
      if (!c.buyers) c.buyers = [];
      c.buyers.push({ id: parseInt(buyerId, 10), name: '—', grantedAt: Date.now() });
      console.log('[grantCourseAccess] Access granted to buyer:', buyerId, 'course:', c.title);
    }
  });
}

function hasCourseAccess(buyerId, courseId) {
  const d = db.get();
  const c = d.courses.find(x => x.id === courseId);
  if (!c) return false;
  return c.buyers?.some(b => b.id === parseInt(buyerId, 10)) || false;
}

/** @deprecated використовуйте mountMonopayWebhook + mountMonopayApi */
function initMonopay(app, webhookRouter) {
  mountMonopayWebhook(webhookRouter);
  mountMonopayApi(app);
}

module.exports = {
  initMonopay,
  mountMonopayWebhook,
  mountMonopayApi,
  grantCourseAccess,
  hasCourseAccess,
  getMonoToken,
};
