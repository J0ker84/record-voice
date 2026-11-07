'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DSP = require('../dsp.js');

const SR = 48000;

// مولد أرقام عشوائية ثابت البذرة لنتائج قابلة للتكرار
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(r(), 1e-12), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** إشارة شبيهة بالكلام: مقاطع صوتية توافقية تتخللها فترات صمت. */
function makeSpeech(seconds) {
  const n = Math.round(SR * seconds);
  const x = new Float32Array(n);
  const mask = new Uint8Array(n);
  let t = Math.round(SR * 1.0); // ثانية صمت في البداية
  let phase = 0;
  while (t < n - SR * 0.5) {
    const dur = Math.round(SR * (0.35 + 0.25 * ((t / SR) % 1)));
    for (let i = 0; i < dur && t + i < n; i++) {
      const tt = i / SR;
      const f0 = 140 + 30 * Math.sin(2 * Math.PI * 3 * tt);
      phase += (2 * Math.PI * f0) / SR;
      const envl = Math.sin((Math.PI * i) / dur);
      let v = 0;
      for (let h = 1; h <= 20; h++) {
        const f = f0 * h;
        // غلاف طيفي بسيط بقمم formants تقريبية
        const amp = 1 / h * (1 + 2 * Math.exp(-((f - 700) ** 2) / 2e5) + 1.5 * Math.exp(-((f - 1800) ** 2) / 4e5));
        v += amp * Math.sin(phase * h);
      }
      x[t + i] = 0.12 * envl * v;
      mask[t + i] = 1;
    }
    t += dur + Math.round(SR * 0.3);
  }
  return { x, mask };
}

function addNoise(clean, noiseDb, humDb, seed) {
  const r = rng(seed);
  const g = DSP.dbToGain(noiseDb), h = DSP.dbToGain(humDb);
  const y = new Float32Array(clean.length);
  for (let i = 0; i < y.length; i++) {
    y[i] = clean[i] + g * gauss(r) + h * Math.sin((2 * Math.PI * 50 * i) / SR) + h * 0.5 * Math.sin((2 * Math.PI * 150 * i) / SR);
  }
  return y;
}

function energy(x, mask, want) {
  let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) if (mask[i] === want) { s += x[i] * x[i]; c++; }
  return s / Math.max(c, 1);
}

/** SNR بعد إيجاد أفضل معامل تكبير بين الإشارة النظيفة والناتج. */
function snr(clean, out) {
  let num = 0, den = 0;
  for (let i = 0; i < clean.length; i++) { num += clean[i] * out[i]; den += clean[i] * clean[i]; }
  const a = num / den;
  let sig = 0, err = 0;
  for (let i = 0; i < clean.length; i++) {
    const s = a * clean[i];
    sig += s * s;
    err += (out[i] - s) ** 2;
  }
  return 10 * Math.log10(sig / err);
}

test('FFT ثم IFFT يعيد الإشارة الأصلية', () => {
  const n = 1024;
  const fft = new DSP.FFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const orig = new Float64Array(n);
  const r = rng(1);
  for (let i = 0; i < n; i++) orig[i] = re[i] = r() - 0.5;
  fft.transform(re, im, false);
  fft.transform(re, im, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('الإزالة الطيفية بشدة صفرية تقريباً تحافظ على الإشارة (إعادة بناء كاملة)', () => {
  const { x } = makeSpeech(3);
  const out = DSP.spectralDenoise(x, SR, { strength: 0 });
  // بدون ضوضاء، يجب أن يبقى الكلام شبه سليم
  assert.ok(snr(x, out) > 15, 'snr=' + snr(x, out));
});

test('إزالة الضوضاء تخفض الضوضاء بوضوح وتحسن SNR', () => {
  const { x: clean, mask } = makeSpeech(6);
  const noisy = addNoise(clean, -32, -30, 7);

  const out = DSP.processVoice(noisy, SR, {
    hum: 50, eq: false, compress: false, normalize: false, gate: true, strength: 0.7,
  }).samples;

  // المرجع يمر بنفس الفلاتر الخطية (تمرير عالٍ + Notch) حتى تكون المقارنة عادلة من ناحية الطور
  const ref = DSP.removeHum(DSP.highpass(Float32Array.from(clean), SR, 80), SR, 50);
  const snrIn = snr(clean, noisy);
  const snrOut = snr(ref, out);
  const noiseIn = 10 * Math.log10(energy(noisy, mask, 0));
  const noiseOut = 10 * Math.log10(energy(out, mask, 0));
  const speechIn = 10 * Math.log10(energy(clean, mask, 1));
  const speechOut = 10 * Math.log10(energy(out, mask, 1));

  console.log(`SNR: ${snrIn.toFixed(1)} dB -> ${snrOut.toFixed(1)} dB`);
  console.log(`مستوى الضوضاء في الفراغات: ${noiseIn.toFixed(1)} dB -> ${noiseOut.toFixed(1)} dB`);
  console.log(`مستوى الكلام: ${speechIn.toFixed(1)} dB -> ${speechOut.toFixed(1)} dB`);

  assert.ok(snrOut > snrIn + 8, 'تحسن SNR غير كافٍ');
  assert.ok(noiseOut < noiseIn - 20, 'الضوضاء في الفراغات لم تنخفض بما يكفي');
  assert.ok(Math.abs(speechOut - speechIn) < 3, 'الكلام تأثر أكثر من اللازم');
});

test('بصمة الضوضاء من أول ثانية تعمل', () => {
  const { x: clean } = makeSpeech(4);
  const noisy = addNoise(clean, -35, -90, 3);
  const out = DSP.spectralDenoise(noisy, SR, { strength: 0.6, noiseProfile: 'start', noiseSeconds: 1 });
  assert.ok(snr(clean, out) > snr(clean, noisy) + 6);
});

test('السلسلة الكاملة مع التطبيع لا تتجاوز -1 dBFS وتعمل مع 16kHz', () => {
  const r = rng(5);
  const x = new Float32Array(16000 * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(i / 10) + 0.01 * gauss(r);
  const res = DSP.processVoice(x, 16000, { compress: true });
  let peak = 0;
  for (const v of res.samples) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); }
  assert.ok(Math.abs(DSP.gainToDb(peak) + 1) < 0.01);
});

test('مدخلات قصيرة جداً أو صامتة لا تسبب أخطاء', () => {
  for (const len of [0, 10, 500, 3000]) {
    const res = DSP.processVoice(new Float32Array(len), SR, {});
    assert.strictEqual(res.samples.length, len);
    for (const v of res.samples) assert.ok(Number.isFinite(v));
  }
});
