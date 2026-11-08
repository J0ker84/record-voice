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
    hum: 50, eq: false, compress: false, normalize: false, gate: true, strength: 0.7, tone: 0, highpassFreq: 80, dereverb: 0,
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

// ------------------------------------------------------------------
// RNNoise (الذكاء الاصطناعي)
// ------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const createRNNWasmModule = require('../vendor/rnnoise/rnnoise.js');
const loadRNNoise = () => createRNNWasmModule({
  wasmBinary: fs.readFileSync(path.join(__dirname, '../vendor/rnnoise/rnnoise.wasm')),
});

/** ضوضاء متغيرة: نقرات كيبورد + دفعات ضجيج متقطعة (لا تصلح لها البصمة الثابتة). */
function nonStationaryNoise(n, seed) {
  const r = rng(seed);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (r() < 6 / SR) {
      for (let k = 0; k < SR * 0.015 && i + k < n; k++) y[i + k] += gauss(r) * Math.exp(-k / (SR * 0.003)) * 4;
    }
    const t = i / SR;
    if (t % 4 < 1.2) y[i] += gauss(r) * 0.8 * Math.sin((Math.PI * (t % 4)) / 1.2);
  }
  return y;
}

test('إعادة التشكيل 16kHz→48kHz→16kHz دقيقة', () => {
  const { x } = makeSpeech(2);
  const x16 = DSP.resample(x, 48000, 16000);
  assert.strictEqual(x16.length, x.length / 3);
  const back = DSP.resample(DSP.resample(x16, 16000, 48000), 48000, 16000);
  assert.strictEqual(back.length, x16.length);
  assert.ok(snr(x16, back) > 60, 'snr=' + snr(x16, back));
});

test('RNNoise: تأخير الخوارزمية معوَّض بالكامل', async () => {
  const mod = await loadRNNoise();
  const { x } = makeSpeech(4);
  const y = DSP.rnnoiseDenoise(x, SR, mod, { strength: 1 }).samples;
  assert.strictEqual(y.length, x.length);
  let best = -Infinity, lag = 0;
  for (let L = -100; L <= 100; L++) {
    let c = 0;
    for (let i = 2000; i < x.length - 2000; i++) c += x[i] * y[i + L];
    if (c > best) { best = c; lag = L; }
  }
  // بدون تعويض سيكون التأخير 480 عينة (10ms)
  assert.ok(Math.abs(lag) <= 2, 'lag=' + lag);
});

test('RNNoise يتفوق على الطريقة الطيفية مع الضوضاء المتغيرة', async () => {
  const mod = await loadRNNoise();
  const { x: clean } = makeSpeech(8);
  const nz = nonStationaryNoise(clean.length, 11);
  let ec = 0, en = 0;
  for (let i = 0; i < clean.length; i++) { ec += clean[i] ** 2; en += nz[i] ** 2; }
  const k = Math.sqrt(ec / en) / DSP.dbToGain(5); // SNR = 5 dB
  const noisy = clean.map((v, i) => v + nz[i] * k);

  const base = { highpass: false, gate: false, eq: false, normalize: false, tone: 0, dereverb: 0, strength: 0.6, rnnoise: mod };
  const spectral = DSP.processVoice(noisy, SR, Object.assign({}, base, { engine: 'spectral' }));
  const ai = DSP.processVoice(noisy, SR, Object.assign({}, base, { engine: 'ai' }));
  const hybrid = DSP.processVoice(noisy, SR, Object.assign({}, base, { engine: 'hybrid' }));
  const r = { input: snr(clean, noisy), spectral: snr(clean, spectral.samples), ai: snr(clean, ai.samples), hybrid: snr(clean, hybrid.samples) };
  console.log('ضوضاء متغيرة (SI-SNR dB):', Object.entries(r).map(([k, v]) => `${k}=${v.toFixed(1)}`).join('  '));

  assert.strictEqual(ai.stats.engine, 'ai');
  assert.strictEqual(hybrid.stats.engine, 'hybrid');
  assert.ok(r.ai > r.input + 3, 'الذكاء الاصطناعي لم يحسّن بما يكفي');
  assert.ok(r.ai > r.spectral + 2, 'الذكاء الاصطناعي لم يتفوق على الطيفي');
  assert.ok(r.hybrid > r.input + 3);
});

test('عند غياب النموذج تُستخدم الطريقة الطيفية تلقائياً', () => {
  const { x } = makeSpeech(2);
  const res = DSP.processVoice(x, SR, { engine: 'hybrid', rnnoise: null });
  assert.strictEqual(res.stats.engine, 'spectral');
});

test('RNNoise يعمل مع معدلات عيّنات مختلفة ومدخلات قصيرة', async () => {
  const mod = await loadRNNoise();
  for (const [len, sr] of [[0, 48000], [100, 48000], [44100, 44100], [16000, 16000], [8000 * 3, 8000]]) {
    const r = rng(len + 1);
    const x = new Float32Array(len).map(() => 0.1 * gauss(r));
    const res = DSP.processVoice(x, sr, { engine: 'hybrid', rnnoise: mod });
    assert.strictEqual(res.samples.length, len);
    for (const v of res.samples) assert.ok(Number.isFinite(v));
  }
});

// ------------------------------------------------------------------
// الجهارة، المحدِّد، القنوات، والمعالجة في المكان
// ------------------------------------------------------------------
test('قياس الجهارة يطابق معيار ITU (نغمة 997Hz بمستوى 0dBFS = -3.01 LUFS)', () => {
  const x = new Float32Array(SR * 5).map((_, i) => Math.sin((2 * Math.PI * 997 * i) / SR));
  assert.ok(Math.abs(DSP.measureLoudness(x, SR, false) + 3.01) < 0.05);
  // الملف الأحادي يُقاس كما يُسمع على السماعتين (+3.01dB)
  assert.ok(Math.abs(DSP.measureLoudness(x, SR) - 0) < 0.05);
  // ومعاملات K-weighting صحيحة عند 44.1kHz أيضاً (الفرق ضئيل جداً)
  const y = new Float32Array(44100 * 5).map((_, i) => Math.sin((2 * Math.PI * 997 * i) / 44100));
  assert.ok(Math.abs(DSP.measureLoudness(y, 44100, false) + 3.01) < 0.1);
});

test('ضبط الجهارة يصل للهدف دون تجاوز -1dBFS', () => {
  for (const target of [-16, -14]) {
    const { x } = makeSpeech(8);
    for (let i = 0; i < x.length; i++) x[i] *= 0.2; // تسجيل منخفض
    DSP.normalizeLoudness(x, SR, target, -1);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    const L = DSP.measureLoudness(x, SR);
    assert.ok(Math.abs(L - target) < 0.3, `target ${target} got ${L.toFixed(2)}`);
    assert.ok(DSP.gainToDb(peak) <= -0.999, 'peak ' + DSP.gainToDb(peak));
  }
});

test('المحدِّد لا يتجاوز السقف ولا يغيّر الأجزاء الهادئة', () => {
  const r = rng(4);
  const x = new Float32Array(SR * 2).map((_, i) => 0.2 * Math.sin(i / 9) + (i === SR ? 3 : 0) + 0.01 * gauss(r));
  const quietBefore = x[SR / 2];
  DSP.limiter(x, SR, -1);
  for (const v of x) assert.ok(Math.abs(v) <= DSP.dbToGain(-1) + 1e-6);
  assert.ok(Math.abs(x[SR / 2] - quietBefore) < 1e-6, 'أثّر على جزء بعيد عن القمة');
});

test('التحويل الذكي إلى Mono يتجاهل القناة الفارغة في الميكروفونات اللاسلكية', () => {
  const { x } = makeSpeech(2);
  const r = rng(8);
  const hiss = new Float32Array(x.length).map(() => 0.0005 * gauss(r));
  const single = DSP.smartMono([hiss, x]);
  assert.strictEqual(single.mode, 'single');
  assert.strictEqual(single.channel, 1);
  assert.deepStrictEqual(single.samples, Float32Array.from(x));
  // قناتان متشابهتان → دمج
  const both = DSP.smartMono([x, x.map((v) => v * 0.8)]);
  assert.strictEqual(both.mode, 'mix');
});

test('المعالجة في المكان (لتوفير الذاكرة) تعطي النتيجة نفسها تماماً', async () => {
  const mod = await loadRNNoise();
  const { x: clean } = makeSpeech(4);
  const noisy = addNoise(clean, -30, -40, 21);
  const opts = { engine: 'hybrid', rnnoise: mod, compress: true, loudness: -16, hum: 50 };
  const a = DSP.processVoice(noisy, SR, opts).samples;
  const b = DSP.processVoice(Float32Array.from(noisy), SR, Object.assign({}, opts, { inPlace: true })).samples;
  assert.strictEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, 'اختلاف عند ' + i);
});

// ------------------------------------------------------------------
// تصحيح النبرة، درجة الصوت، والفلتر المتكيّف
// ------------------------------------------------------------------
/** "كلام" بطيف عريض: دفعات من ضوضاء وردية بغلاف مقاطع (يغطي كل الترددات). */
function broadbandSpeechLike(seconds, seed) {
  const r = rng(seed), n = Math.round(SR * seconds), x = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = gauss(r);
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    const t = i / SR, env = t % 0.7 < 0.45 ? Math.sin((Math.PI * (t % 0.7)) / 0.45) : 0;
    x[i] = 0.05 * env * (b0 + b1 + b2 + w * 0.1848);
  }
  return x;
}

test('مرشح المنحنى بقيم صفرية لا يغيّر الإشارة، والمعالجة في المكان مطابقة', () => {
  const x = broadbandSpeechLike(3, 2);
  const flat = DSP.applyEqCurve(x, SR, [[1000, 0], [8000, 0]]);
  assert.ok(snr(x, flat) > 60, 'snr=' + snr(x, flat));
  const pts = [[1000, 0], [3000, 6], [8000, 10]];
  const a = DSP.applyEqCurve(x, SR, pts);
  const b = DSP.applyEqCurve(Float32Array.from(x), SR, pts, true);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6);
});

test('تصحيح النبرة يعوّض صوتاً مكتوماً (نقص الترددات العالية)', () => {
  // نبدأ بإشارة قريبة من النبرة المرجعية (3 تمريرات تصحيح) حتى لا نصطدم بحدود المنحنى
  let x = broadbandSpeechLike(8, 3);
  for (let k = 0; k < 3; k++) x = DSP.applyEqCurve(x, SR, DSP.toneCorrection(x, SR, 1).points);
  const muffled = Float32Array.from(x);
  DSP.applyBiquad(muffled, DSP.biquadCoeffs('highshelf', 2500, SR, 0.7071, -8)); // كتم بمقدار 8dB
  const c0 = DSP.toneCorrection(x, SR, 1), c1 = DSP.toneCorrection(muffled, SR, 1);
  const at = (c, f) => c.points.find((p) => p[0] === f)[1];
  for (const f of [5000, 6300, 8000]) {
    const extra = at(c1, f) - at(c0, f);
    // المنحنى محدود بـ +12dB، لذا نقارن حيث لا يصل للحد
    if (at(c1, f) < 11.9) assert.ok(Math.abs(extra - 8) < 2.5, `at ${f}Hz extra boost ${extra.toFixed(1)} (expected ≈ 8)`);
  }
  assert.ok(at(c1, 500) === 0 && at(c1, 630) === 0, 'لا يجب تغيير ما تحت 800Hz');
  // الشدة صفر = بلا تغيير
  assert.ok(DSP.toneCorrection(muffled, SR, 0).points.every((p) => p[1] === 0));
});

test('تقدير درجة الصوت والفلتر المنخفض المتكيّف', () => {
  const { x } = makeSpeech(6); // درجة الصوت ~140Hz ±30
  const p = DSP.estimatePitch(x, SR);
  assert.ok(p && p.median > 115 && p.median < 165, 'median=' + (p && p.median));
  const res = DSP.processVoice(x, SR, { denoise: false });
  assert.ok(res.stats.highpassHz >= 40 && res.stats.highpassHz <= 80);
  assert.ok(res.stats.highpassHz < p.p10, 'الفلتر يجب أن يكون تحت درجة الصوت');
  // صوت عميق جداً (80Hz) → فلتر أخفض من 80
  const deep = new Float32Array(SR * 4).map((_, i) => { const t = i / SR; let v = 0; for (let h = 1; h < 15; h++) v += Math.sin(2 * Math.PI * 80 * h * t) / h; return (t % 1 < 0.6 ? 0.1 : 0) * v; });
  const rd = DSP.processVoice(deep, SR, { denoise: false });
  assert.ok(rd.stats.highpassHz < 70, 'hp=' + rd.stats.highpassHz);
});

// ------------------------------------------------------------------
// البوابة المعتمدة على كاشف الكلام (VAD)
// ------------------------------------------------------------------
test('بوابة VAD: تُبقي الكلام، تخفض غير الكلام 20dB، وتفتح قبل بداية الكلام', () => {
  const sr = 48000;
  const vad = new Float32Array(300); // 3 ثوانٍ: صمت 1s، كلام 1s، صمت 1s
  for (let f = 100; f < 200; f++) vad[f] = 0.95;
  const g = new Float32Array(sr * 3).fill(1);
  DSP.vadGate(g, sr, vad);
  const db = (i) => DSP.gainToDb(g[i]);
  assert.ok(db(Math.round(0.8 * sr)) < -19, 'الصمت الأول لم يُخفض');
  assert.ok(db(Math.round(1.5 * sr)) > -0.1, 'الكلام تأثر');
  assert.ok(db(Math.round(0.975 * sr)) > -1, 'لم تُفتح البوابة قبل بداية الكلام (حماية الحروف الأولى)');
  assert.ok(db(Math.round(2.1 * sr)) > -1, 'أُغلقت البوابة مبكراً بعد نهاية الكلام');
  assert.ok(db(Math.round(2.9 * sr)) < -19, 'الصمت الأخير لم يُخفض');
});

test('مع الذكاء الاصطناعي تُستخدم بوابة VAD، وبدونه بوابة المستوى', async () => {
  const mod = await loadRNNoise();
  const { x: clean } = makeSpeech(4);
  const noisy = addNoise(clean, -45, -90, 31);
  assert.strictEqual(DSP.processVoice(noisy, SR, { engine: 'hybrid', rnnoise: mod }).stats.gate, 'vad');
  assert.strictEqual(DSP.processVoice(noisy, SR, { engine: 'spectral' }).stats.gate, 'level');
  assert.strictEqual(DSP.processVoice(noisy, SR, { engine: 'hybrid', rnnoise: mod, gate: false }).stats.gate, null);
});

// ------------------------------------------------------------------
// تخفيف صدى الغرفة
// ------------------------------------------------------------------
function fftConv(x, h) {
  let N = 1; while (N < h.length * 2) N <<= 1; N = Math.max(N, 65536);
  const B = N - h.length + 1, fft = new DSP.FFT(N);
  const Hr = new Float64Array(N), Hi = new Float64Array(N); Hr.set(h); fft.transform(Hr, Hi, false);
  const y = new Float32Array(x.length), re = new Float64Array(N), im = new Float64Array(N);
  for (let o = 0; o < x.length; o += B) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < B && o + i < x.length; i++) re[i] = x[o + i];
    fft.transform(re, im, false);
    for (let k = 0; k < N; k++) { const a = re[k] * Hr[k] - im[k] * Hi[k], b = re[k] * Hi[k] + im[k] * Hr[k]; re[k] = a; im[k] = b; }
    fft.transform(re, im, true);
    for (let i = 0; i < N && o + i < y.length; i++) y[o + i] += re[i];
  }
  return y;
}

test('تخفيف الصدى يخفض ذيل الصدى بعد الكلام دون تغيير جسم الكلام', () => {
  const r = rng(12);
  const dry = broadbandSpeechLike(6, 5); // مقاطع 0.45s يليها صمت 0.25s
  // استجابة غرفة: صوت مباشر + ذيل أسّي (RT60 = 0.6s) أضعف منه بـ 4dB
  const n = Math.round(SR * 0.8), h = new Float64Array(n); h[0] = 1;
  let e = 0; const tail = new Float64Array(n);
  for (let i = Math.round(0.005 * SR); i < n; i++) { tail[i] = gauss(r) * Math.exp((-6.9078 * (i / SR)) / 0.6); e += tail[i] ** 2; }
  const k = Math.sqrt(Math.pow(10, -0.4) / e); for (let i = 0; i < n; i++) h[i] += tail[i] * k;
  const wet = fftConv(dry, h);
  const out = DSP.dereverb(wet, SR, { strength: 0.5 });
  // الذيل: 60–220ms بعد نهاية كل مقطع؛ الجسم: منتصف المقطع
  const lvl = (y, a, b) => { let s = 0, c = 0; for (let t = 0.7; t < 5.5; t += 0.7) { for (let i = Math.round((t + a) * SR); i < Math.round((t + b) * SR); i++) { s += y[i] ** 2; c++; } } return 10 * Math.log10(s / c); };
  const tailIn = lvl(wet, 0.51, 0.67) - lvl(wet, 0.1, 0.35), tailOut = lvl(out, 0.51, 0.67) - lvl(out, 0.1, 0.35);
  const bodyChange = lvl(out, 0.1, 0.35) - lvl(wet, 0.1, 0.35);
  console.log(`ذيل الصدى نسبةً للكلام: ${tailIn.toFixed(1)} dB → ${tailOut.toFixed(1)} dB | تغيّر جسم الكلام ${bodyChange.toFixed(1)} dB`);
  assert.ok(tailOut < tailIn - 3, 'الذيل لم ينخفض بما يكفي');
  assert.ok(Math.abs(bodyChange) < 1.5, 'جسم الكلام تغيّر كثيراً');
});

test('تخفيف الصدى: الشدة صفر لا تغيّر شيئاً، والمعالجة في المكان مطابقة', () => {
  const x = broadbandSpeechLike(2, 6);
  assert.deepStrictEqual(DSP.dereverb(x, SR, { strength: 0 }), x);
  const a = DSP.dereverb(x, SR, { strength: 0.5 });
  const b = DSP.dereverb(Float32Array.from(x), SR, { strength: 0.5, inPlace: true });
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6);
});

// ------------------------------------------------------------------
// كشف الطنين الكهربائي تلقائياً
// ------------------------------------------------------------------
test('كشف الطنين: 50Hz و60Hz يُكتشفان، والكلام النظيف لا يُطلق إنذاراً كاذباً', () => {
  const { x } = makeSpeech(8);
  const withHum = (f) => { const r = rng(f); return x.map((v, i) => v + 0.004 * Math.sin((2 * Math.PI * f * i) / SR) + 0.0015 * Math.sin((2 * Math.PI * 2 * f * i) / SR) + 0.0003 * gauss(r)); };
  assert.strictEqual((DSP.detectHum(withHum(50), SR) || {}).freq, 50);
  assert.strictEqual((DSP.detectHum(withHum(60), SR) || {}).freq, 60);
  const r = rng(3);
  assert.strictEqual(DSP.detectHum(x.map((v) => v + 0.0003 * gauss(r)), SR), null);
  // في السلسلة الكاملة (الافتراضي = تلقائي)
  assert.strictEqual(DSP.processVoice(withHum(50), SR, { denoise: false }).stats.humHz, 50);
  assert.strictEqual(DSP.processVoice(withHum(50), SR, { denoise: false, hum: 0 }).stats.humHz, null);
});
