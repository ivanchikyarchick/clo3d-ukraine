/**
 * Certificate PNG generator using node-canvas
 * Generates a beautiful Vitalia Fashion Lab certificate as PNG
 */

const path = require('path');
const fs   = require('fs');

async function generateCertPNG(buyerName, courseTitle, outPath) {
  let createCanvas, loadImage, registerFont;
  try {
    ({ createCanvas, loadImage, registerFont } = require('canvas'));
  } catch(e) {
    console.warn('[cert] canvas not available:', e.message);
    return null;
  }

  const W = 1200, H = 850;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // ── Background ───────────────────────────────────────────
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0,   '#080810');
  bg.addColorStop(0.5, '#0d0d1a');
  bg.addColorStop(1,   '#060612');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // ── Decorative corner circles ─────────────────────────────
  const drawCornerCircle = (x, y, r, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(91,141,238,${alpha})`);
    g.addColorStop(1, 'rgba(91,141,238,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  };
  drawCornerCircle(0,   0,   300, 0.18);
  drawCornerCircle(W,   H,   280, 0.15);
  drawCornerCircle(W,   0,   200, 0.10);
  drawCornerCircle(0,   H,   180, 0.08);

  // ── Outer border ─────────────────────────────────────────
  const margin = 32;
  const grad = ctx.createLinearGradient(margin, margin, W-margin, H-margin);
  grad.addColorStop(0,   'rgba(91,141,238,0.6)');
  grad.addColorStop(0.5, 'rgba(167,139,250,0.6)');
  grad.addColorStop(1,   'rgba(244,114,182,0.4)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.5;
  roundRect(ctx, margin, margin, W-margin*2, H-margin*2, 20);
  ctx.stroke();

  // Inner border
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  roundRect(ctx, margin+10, margin+10, W-margin*2-20, H-margin*2-20, 14);
  ctx.stroke();

  // ── Top accent line ───────────────────────────────────────
  const topLine = ctx.createLinearGradient(W*0.25, 0, W*0.75, 0);
  topLine.addColorStop(0,   'rgba(91,141,238,0)');
  topLine.addColorStop(0.5, 'rgba(167,139,250,0.9)');
  topLine.addColorStop(1,   'rgba(91,141,238,0)');
  ctx.strokeStyle = topLine;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W*0.25, margin+1); ctx.lineTo(W*0.75, margin+1); ctx.stroke();

  // ── Logo / brand ──────────────────────────────────────────
  ctx.textAlign = 'center';

  // Brand name
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = 'rgba(167,139,250,0.7)';
  ctx.letterSpacing = '0.3em';
  ctx.fillText('VITALIA FASHION LAB', W/2, 115);

  // Decorative divider
  drawDivider(ctx, W/2, 140, 180);

  // ── Certificate heading ───────────────────────────────────
  ctx.font = '13px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('С Е Р Т И Ф І К А Т   П Р О   З А В Е Р Ш Е Н Н Я', W/2, 175);

  // ── "Це підтверджує що" ───────────────────────────────────
  ctx.font = '16px sans-serif';
  ctx.fillStyle = 'rgba(107,101,160,1)';
  ctx.fillText('Цим підтверджується, що', W/2, 230);

  // ── Student name ──────────────────────────────────────────
  ctx.font = 'bold 54px sans-serif';
  const nameGrad = ctx.createLinearGradient(W/2-250, 0, W/2+250, 0);
  nameGrad.addColorStop(0,   '#e8e4ff');
  nameGrad.addColorStop(0.5, '#ffffff');
  nameGrad.addColorStop(1,   '#c8c0ff');
  ctx.fillStyle = nameGrad;
  ctx.fillText(buyerName || 'Учень', W/2, 305);

  // Name underline
  const nameWidth = ctx.measureText(buyerName || 'Учень').width;
  const ul = ctx.createLinearGradient(W/2 - nameWidth/2, 0, W/2 + nameWidth/2, 0);
  ul.addColorStop(0,   'rgba(91,141,238,0)');
  ul.addColorStop(0.5, 'rgba(167,139,250,0.8)');
  ul.addColorStop(1,   'rgba(91,141,238,0)');
  ctx.strokeStyle = ul; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W/2 - nameWidth/2, 315);
  ctx.lineTo(W/2 + nameWidth/2, 315);
  ctx.stroke();

  // ── "успішно завершив(ла) курс" ───────────────────────────
  ctx.font = '16px sans-serif';
  ctx.fillStyle = 'rgba(107,101,160,1)';
  ctx.fillText('успішно завершив(ла) курс', W/2, 365);

  // ── Course name box ───────────────────────────────────────
  const courseTitle2 = courseTitle || 'Курс CLO3D';
  ctx.font = 'bold 30px sans-serif';
  const cw = ctx.measureText(`«${courseTitle2}»`).width + 60;
  const ch = 58, cx = (W-cw)/2, cy = 385;

  // box bg
  const boxGrad = ctx.createLinearGradient(cx, cy, cx+cw, cy+ch);
  boxGrad.addColorStop(0, 'rgba(91,141,238,0.12)');
  boxGrad.addColorStop(1, 'rgba(167,139,250,0.08)');
  ctx.fillStyle = boxGrad;
  roundRect(ctx, cx, cy, cw, ch, 12);
  ctx.fill();

  ctx.strokeStyle = 'rgba(167,139,250,0.3)';
  ctx.lineWidth = 1;
  roundRect(ctx, cx, cy, cw, ch, 12);
  ctx.stroke();

  const courseGrad = ctx.createLinearGradient(cx, 0, cx+cw, 0);
  courseGrad.addColorStop(0,   '#7c9eff');
  courseGrad.addColorStop(0.5, '#c084fc');
  courseGrad.addColorStop(1,   '#f472b6');
  ctx.fillStyle = courseGrad;
  ctx.fillText(`«${courseTitle2}»`, W/2, cy + ch/2 + 10);

  // ── Divider ───────────────────────────────────────────────
  drawDivider(ctx, W/2, 490, 120);

  // ── Date ─────────────────────────────────────────────────
  const date = new Date().toLocaleDateString('uk-UA', { day:'numeric', month:'long', year:'numeric' });
  ctx.font = '14px sans-serif';
  ctx.fillStyle = 'rgba(107,101,160,0.8)';
  ctx.fillText(date, W/2, 525);

  // ── Bottom decorative section ─────────────────────────────
  // Stars
  const starPositions = [[W*0.2, 590], [W*0.5, 575], [W*0.8, 590]];
  for (const [sx, sy] of starPositions) {
    drawStar(ctx, sx, sy, 5, 12, 5, 'rgba(251,191,36,0.6)');
  }

  // Seal circle
  const sealX = W/2, sealY = 650, sealR = 50;
  const sealGrad = ctx.createRadialGradient(sealX, sealY, 0, sealX, sealY, sealR);
  sealGrad.addColorStop(0, 'rgba(251,191,36,0.2)');
  sealGrad.addColorStop(0.6, 'rgba(251,191,36,0.08)');
  sealGrad.addColorStop(1, 'rgba(251,191,36,0)');
  ctx.fillStyle = sealGrad;
  ctx.beginPath(); ctx.arc(sealX, sealY, sealR, 0, Math.PI*2); ctx.fill();

  ctx.strokeStyle = 'rgba(251,191,36,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(sealX, sealY, sealR, 0, Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.arc(sealX, sealY, sealR-7, 0, Math.PI*2); ctx.stroke();

  ctx.font = '30px sans-serif';
  ctx.fillText('🏆', sealX, sealY + 12);

  // ── Bottom text ───────────────────────────────────────────
  ctx.font = '12px sans-serif';
  ctx.fillStyle = 'rgba(107,101,160,0.5)';
  ctx.fillText('vitaliafashionlab.com  ·  @Clo3dua_bot', W/2, H - 50);

  // ── Save file ─────────────────────────────────────────────
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r);
  ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h);
  ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r);
  ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}

function drawDivider(ctx, cx, cy, halfW) {
  const g = ctx.createLinearGradient(cx-halfW, 0, cx+halfW, 0);
  g.addColorStop(0,   'rgba(91,141,238,0)');
  g.addColorStop(0.5, 'rgba(167,139,250,0.5)');
  g.addColorStop(1,   'rgba(91,141,238,0)');
  ctx.strokeStyle = g; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx-halfW, cy); ctx.lineTo(cx+halfW, cy); ctx.stroke();
  // Center diamond
  ctx.fillStyle = 'rgba(167,139,250,0.7)';
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI/4);
  ctx.fillRect(-4, -4, 8, 8);
  ctx.restore();
}

function drawStar(ctx, cx, cy, spikes, outerR, innerR, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  let rot = (Math.PI/2)*3;
  const step = Math.PI / spikes;
  ctx.moveTo(cx, cy - outerR);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot)*outerR, cy + Math.sin(rot)*outerR);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot)*innerR, cy + Math.sin(rot)*innerR);
    rot += step;
  }
  ctx.lineTo(cx, cy - outerR);
  ctx.closePath(); ctx.fill();
}

module.exports = { generateCertPNG };
