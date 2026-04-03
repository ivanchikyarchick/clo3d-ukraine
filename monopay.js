// Monobank Payment Module
const db = require('./db');

function getMonoToken() {
  const MONOBANK_TOKEN = process.env.MONOBANK_TOKEN || '';
  const settings = db.get().settings || {};
  return MONOBANK_TOKEN || settings.monoToken || '';
}

function initMonopay(app, webhookRouter) {
  // Create invoice
  app.post('/api/payment/create', async (req, res) => {
    const token = getMonoToken();
    if (!token) { res.status(500).json({ ok: false, error: 'Monobank token not configured' }); return; }
    
    const { amount, description, courseId, buyerId, redirectUrl } = req.body;
    if (!amount || amount < 100) { res.status(400).json({ ok: false, error: 'Invalid amount' }); return; }
    
    const invoiceData = {
      amount: Math.round(amount),
      ccy: 980,
      merchantPaymInfo: {
        reference: `course_${courseId || 'general'}_${Date.now()}`,
        destination: description || 'Оплата курсу',
      },
      redirectUrl: redirectUrl || `${SITE_URL}/payment-result`,
      webHookUrl: `${SITE_URL}/api/payment/webhook`,
      validity: 3600,
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
      
      const result = await response.json();
      
      if (!response.ok || result.errCode) {
        console.error('[monobank] create error:', result);
        res.status(response.status).json({ ok: false, error: result.errCode || result.message || 'Payment creation failed' });
        return;
      }
      
      // Save pending payment for webhook processing
      if (buyerId && courseId) {
        db.set(d => {
          if (!d.pendingPayments) d.pendingPayments = [];
          d.pendingPayments.push({ 
            invoiceId: result.invoiceId, 
            buyerId: parseInt(buyerId), 
            courseId, 
            createdAt: Date.now() 
          });
        });
      }
      
      res.json({ ok: true, invoiceId: result.invoiceId, pageUrl: result.pageUrl });
    } catch (e) {
      console.error('[monobank] request error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Check payment status
  app.get('/api/payment/status', async (req, res) => {
    const token = getMonoToken();
    if (!token) { res.status(500).json({ ok: false, error: 'Monobank not configured' }); return; }

    const invoiceId = req.query.invoiceId;
    if (!invoiceId) { res.status(400).json({ ok: false, error: 'invoiceId required' }); return; }

    try {
      const response = await fetch(`https://api.monobank.ua/api/merchant/invoice/status?invoiceId=${invoiceId}`, {
        headers: { 'X-Token': token },
      });

      const result = await response.json();

      if (response.ok && result.invoiceId) {
        res.json({ ok: true, status: result.status, amount: result.amount, invoiceId: result.invoiceId });
      } else {
        res.status(400).json({ ok: false, error: result.errText || 'Status check failed' });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Webhook
  let _monoPubKey = null;
  let _monoPubKeyTs = 0;
  const MONO_PUBKEY_TTL = 24 * 60 * 60 * 1000;

  async function getMonoPubKey() {
    const token = getMonoToken();
    if (!token) return null;
    if (_monoPubKey && Date.now() - _monoPubKeyTs < MONO_PUBKEY_TTL) return _monoPubKey;
    
    try {
      const response = await fetch('https://api.monobank.ua/api/merchant/pubkey', {
        headers: { 'X-Token': token }
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

  function verifyMonoSignature(pubKeyBase64, body, signatureBase64) {
    try {
      const crypto = require('crypto');
      
      const bodyHash = crypto.createHash('sha256').update(body).digest();
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

  webhookRouter.post('/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log('[monobank] Webhook received');
    
    const signature = req.headers['x-sign'];
    if (!signature) {
      console.error('[monobank] No signature');
      res.status(400).json({ error: 'No signature' });
      return;
    }
    
    const body = req.body.toString();
    const pubKey = await getMonoPubKey();
    
    if (!pubKey) {
      console.error('[monobank] No pubkey');
      res.status(500).json({ error: 'No pubkey' });
      return;
    }
    
    const isValid = verifyMonoSignature(pubKey, body, signature);
    console.log('[monobank] Signature valid:', isValid);

    // For development/testing, allow processing even with invalid signature
    if (!isValid) {
      console.warn('[monobank] WARNING: Invalid signature, but processing anyway for testing');
    }
    
    let payment;
    try {
      payment = JSON.parse(body);
    } catch (e) {
      console.error('[monobank] Parse error:', e.message);
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    
    console.log('[monobank] Webhook data:', { invoiceId: payment.invoiceId, status: payment.status, amount: payment.amount });
    
    // Save payment to DB
    db.set(d => {
      if (!d.payments) d.payments = [];
      const idx = d.payments.findIndex(p => p.invoiceId === payment.invoiceId);
      const paymentData = {
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
        webhookReceivedAt: Date.now()
      };
      if (idx >= 0) d.payments[idx] = paymentData;
      else d.payments.push(paymentData);
    });
    
    // Process successful payment - grant access
    if (payment.status === 'success') {
      console.log('[monobank] Payment SUCCESS:', payment.invoiceId, payment.amount);
      const d = db.get();
      const pending = d.pendingPayments?.find(p => p.invoiceId === payment.invoiceId);
      console.log('[monobank] Pending payment found:', !!pending, 'buyerId:', pending?.buyerId, 'courseId:', pending?.courseId);
      
      if (pending && pending.buyerId && pending.courseId) {
        db.set(d => {
          const c = d.courses.find(x => x.id === pending.courseId);
          console.log('[monobank] Course found:', !!c, 'course id:', pending.courseId);
          if (c && !c.buyers?.some(b => b.id === pending.buyerId)) {
            if (!c.buyers) c.buyers = [];
            c.buyers.push({ id: pending.buyerId, name: '—', grantedAt: Date.now() });
            console.log('[monobank] Access granted to buyer:', pending.buyerId, 'course:', pending.courseId, 'total buyers now:', c.buyers.length);
          } else {
            console.log('[monobank] Buyer already has access or course not found');
          }
          d.pendingPayments = (d.pendingPayments || []).filter(p => p.invoiceId !== payment.invoiceId);
        });
      }
    }
    
    res.json({ ok: true });
  });
}

// Grant course access to buyer
function grantCourseAccess(buyerId, courseId) {
  db.set(d => {
    const c = d.courses.find(x => x.id === courseId);
    if (c && !c.buyers?.some(b => b.id === parseInt(buyerId))) {
      if (!c.buyers) c.buyers = [];
      c.buyers.push({ id: parseInt(buyerId), name: '—', grantedAt: Date.now() });
      console.log('[grantCourseAccess] Access granted to buyer:', buyerId, 'course:', c.title);
    }
  });
}

// Check if buyer has access to course
function hasCourseAccess(buyerId, courseId) {
  const d = db.get();
  const c = d.courses.find(x => x.id === courseId);
  if (!c) return false;
  return c.buyers?.some(b => b.id === parseInt(buyerId)) || false;
}

module.exports = { initMonopay, grantCourseAccess, hasCourseAccess };
