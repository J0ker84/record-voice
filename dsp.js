/*
 * AudioDSP — مكتبة معالجة وتنقية الصوت (بدون أي اعتماديات خارجية)
 *
 * سلسلة المعالجة:
 *   1. فلتر تمرير عالٍ        (إزالة الهمهمة والاهتزازات المنخفضة)
 *   2. إزالة الطنين الكهربائي (Notch على 50/60Hz وتوافقياتها)
 *   3. إزالة الضوضاء الطيفية  (Wiener + Decision-Directed مع بصمة ضوضاء)
 *   4. بوابة ضوضاء ناعمة      (Downward expander لكتم الفراغات)
 *   5. تحسين وضوح الصوت       (EQ للصوت البشري)
 *   6. ضغط ديناميكي           (توحيد مستوى الصوت)
 *   7. تطبيع المستوى          (Peak normalize إلى -1 dBFS)
 *
 * يعمل في المتصفح (نافذة أو Web Worker) وفي Node.js.
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // أدوات مساعدة
  // ------------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dbToGain = (db) => Math.pow(10, db / 20);
  const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));

  /** دمج عدة قنوات في قناة واحدة (Mono). */
  function toMono(channels) {
    if (channels.length === 1) return Float32Array.from(channels[0]);
    const len = channels[0].length;
    const out = new Float32Array(len);
    const k = 1 / channels.length;
    for (const ch of channels) {
      for (let i = 0; i < len; i++) out[i] += ch[i] * k;
    }
    return out;
  }

  /** نسبة مئوية (percentile) لمصفوفة أرقام. */
  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = Float64Array.from(values).sort();
    const idx = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
    return sorted[idx];
  }

  /**
   * إحصائيات المستوى: مستوى الضوضاء (أهدأ 10%) ومستوى الكلام (أعلى 5%)
   * محسوبة على إطارات طولها 20ms.
   */
  function levelStats(x, sr) {
    const frame = Math.max(1, Math.round(sr * 0.02));
    const levels = [];
    for (let off = 0; off + frame <= x.length; off += frame) {
      let s = 0;
      for (let i = off; i < off + frame; i++) s += x[i] * x[i];
      const rms = Math.sqrt(s / frame);
      if (rms > 1e-7) levels.push(gainToDb(rms)); // تجاهل الصمت الرقمي التام
    }
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (!levels.length) {
      return { noiseDb: -120, speechDb: -120, snrDb: 0, peakDb: gainToDb(peak) };
    }
    const noiseDb = percentile(levels, 0.1);
    const speechDb = percentile(levels, 0.95);
    return { noiseDb, speechDb, snrDb: speechDb - noiseDb, peakDb: gainToDb(peak) };
  }

  // ------------------------------------------------------------------
  // FFT (radix-2، تكراري)
  // ------------------------------------------------------------------
  function FFT(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }

  FFT.prototype.transform = function (re, im, inverse) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cs[t], wi = sign * sn[t];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) {
      const k = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= k; im[i] *= k; }
    }
  };

  const fftCache = new Map();
  function getFFT(n) {
    if (!fftCache.has(n)) fftCache.set(n, new FFT(n));
    return fftCache.get(n);
  }

  // ------------------------------------------------------------------
  // فلاتر Biquad (RBJ Audio EQ Cookbook)
  // ------------------------------------------------------------------
  function biquadCoeffs(type, f0, sr, q, gainDb) {
    const A = Math.pow(10, (gainDb || 0) / 40);
    const w0 = (2 * Math.PI * clamp(f0, 1, sr * 0.49)) / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1; b1 = -2 * cw; b2 = 1;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + s);
        b1 = -2 * A * ((A - 1) + (A + 1) * cw);
        b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s;
        a1 = 2 * ((A - 1) - (A + 1) * cw);
        a2 = (A + 1) - (A - 1) * cw - s;
        break;
      }
      default:
        throw new Error('Unknown filter type: ' + type);
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  /** تطبيق فلتر Biquad على الإشارة (في المكان نفسه) — Transposed Direct Form II. */
  function applyBiquad(x, c) {
    let z1 = 0, z2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = c.b0 * v + z1;
      z1 = c.b1 * v - c.a1 * y + z2;
      z2 = c.b2 * v - c.a2 * y;
      x[i] = y;
    }
    return x;
  }

  function highpass(x, sr, freq) {
    // فلتر من الدرجة الرابعة (Butterworth: مرحلتان)
    applyBiquad(x, biquadCoeffs('highpass', freq, sr, 0.5412));
    applyBiquad(x, biquadCoeffs('highpass', freq, sr, 1.3066));
    return x;
  }

  function removeHum(x, sr, baseFreq, harmonics) {
    const count = harmonics || 6;
    for (let h = 1; h <= count; h++) {
      const f = baseFreq * h;
      if (f >= sr * 0.45) break;
      applyBiquad(x, biquadCoeffs('notch', f, sr, 25));
    }
    return x;
  }

  function voiceEQ(x, sr) {
    applyBiquad(x, biquadCoeffs('peaking', 250, sr, 1.0, -2.5));  // تقليل "الطين"
    applyBiquad(x, biquadCoeffs('peaking', 3200, sr, 0.9, 3));    // وضوح ونطق الحروف
    if (sr > 24000) applyBiquad(x, biquadCoeffs('highshelf', 10000, sr, 0.7071, 1.5)); // "هواء"
    return x;
  }

  // ------------------------------------------------------------------
  // إزالة الضوضاء الطيفية
  // ------------------------------------------------------------------
  /**
   * @param {Float32Array} x
   * @param {number} sr
   * @param {object} opts
   *   strength: 0..1    شدة الإزالة
   *   noiseProfile: 'auto' | 'start'
   *   noiseSeconds: عدد الثواني الأولى المستخدمة كبصمة (عند 'start')
   * @param {function} [progress] (0..1)
   */
  function spectralDenoise(x, sr, opts, progress) {
    opts = opts || {};
    const strength = clamp(opts.strength == null ? 0.6 : opts.strength, 0, 1);
    const N = sr > 32000 ? 2048 : 1024;
    const hop = N / 4;
    const half = N / 2;
    const fft = getFFT(N);
    const len = x.length;
    if (len === 0) return new Float32Array(0);

    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

    const padded = new Float32Array(len + 2 * N);
    padded.set(x, N);
    const frames = Math.floor((padded.length - N) / hop) + 1;

    // --- المرحلة 1: طاقة كل إطار
    const energy = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      let s = 0;
      for (let i = 0; i < N; i++) { const v = padded[off + i] * win[i]; s += v * v; }
      energy[f] = s / N;
    }

    // الإطارات الواقعة كلياً داخل الإشارة (بدون حشو)
    let inside = [];
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      if (off >= N && off + N <= N + len) inside.push(f);
    }
    if (!inside.length) inside = Array.from({ length: frames }, (_, i) => i);

    // --- المرحلة 2: اختيار إطارات بصمة الضوضاء
    let noiseFrames = [];
    if (opts.noiseProfile === 'start') {
      const limit = N + sr * (opts.noiseSeconds || 1);
      noiseFrames = inside.filter((f) => f * hop + N <= limit);
    }
    if (noiseFrames.length < 3) {
      // تلقائي: أهدأ 15% من الإطارات (مع استبعاد الصمت الرقمي التام)
      let cands = inside.filter((f) => energy[f] > 1e-14);
      if (!cands.length) cands = inside;
      cands.sort((a, b) => energy[a] - energy[b]);
      const count = Math.max(3, Math.round(cands.length * 0.15));
      noiseFrames = cands.slice(0, Math.min(count, cands.length));
    }

    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const noise = new Float64Array(half + 1);
    for (const f of noiseFrames) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = padded[off + i] * win[i]; im[i] = 0; }
      fft.transform(re, im, false);
      for (let k = 0; k <= half; k++) noise[k] += re[k] * re[k] + im[k] * im[k];
    }
    // متوسط + تنعيم بسيط عبر الترددات
    const noiseS = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) noise[k] /= noiseFrames.length;
    for (let k = 0; k <= half; k++) {
      const a = noise[Math.max(0, k - 1)], b = noise[k], c = noise[Math.min(half, k + 1)];
      noiseS[k] = (a + 2 * b + c) / 4 + 1e-20;
    }

    // --- المرحلة 3: مرشح Wiener مع تقدير SNR المسبق (Decision-Directed)
    const beta = 1 + 2.5 * strength;                // معامل الطرح الزائد
    const floor = dbToGain(-(6 + 34 * strength));   // أقصى تخفيض: 6dB .. 40dB
    const alphaDD = 0.98;
    const prevS2 = new Float64Array(half + 1);
    const G = new Float64Array(half + 1);
    const Gs = new Float64Array(half + 1);
    const out = new Float64Array(padded.length);
    const reportEvery = Math.max(1, Math.floor(frames / 50));

    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = padded[off + i] * win[i]; im[i] = 0; }
      fft.transform(re, im, false);

      for (let k = 0; k <= half; k++) {
        const P = re[k] * re[k] + im[k] * im[k];
        const Nk = beta * noiseS[k];
        const gamma = P / Nk;
        const xi = alphaDD * (prevS2[k] / Nk) + (1 - alphaDD) * Math.max(gamma - 1, 0);
        G[k] = xi / (1 + xi);
      }
      for (let k = 0; k <= half; k++) {
        const a = G[Math.max(0, k - 1)], b = G[k], c = G[Math.min(half, k + 1)];
        Gs[k] = Math.max((a + 2 * b + c) / 4, floor);
      }
      for (let k = 0; k <= half; k++) {
        const g = Gs[k];
        prevS2[k] = (re[k] * re[k] + im[k] * im[k]) * g * g;
        re[k] *= g; im[k] *= g;
        if (k > 0 && k < half) { re[N - k] *= g; im[N - k] *= g; }
      }

      fft.transform(re, im, true);
      for (let i = 0; i < N; i++) out[off + i] += re[i] * win[i];

      if (progress && f % reportEvery === 0) progress(f / frames);
    }

    // مجموع مربعات نافذة Hann عند تداخل 75% = 1.5
    const result = new Float32Array(len);
    const k = 1 / 1.5;
    for (let i = 0; i < len; i++) result[i] = out[N + i] * k;
    if (progress) progress(1);
    return result;
  }

  // ------------------------------------------------------------------
  // بوابة الضوضاء (Downward expander) — عتبة تلقائية
  // ------------------------------------------------------------------
  function noiseGate(x, sr, opts) {
    opts = opts || {};
    const st = levelStats(x, sr);
    let thrDb = opts.thresholdDb;
    if (thrDb == null) {
      // فوق مستوى الضوضاء بـ 6dB، لكن ليس أعلى من (مستوى الكلام - 18dB)
      thrDb = Math.min(st.noiseDb + 6, st.speechDb - 18);
    }
    const ratio = opts.ratio || 3;
    const rangeDb = opts.rangeDb || -30;
    const envAtt = Math.exp(-1 / (0.002 * sr));
    const envRel = Math.exp(-1 / (0.06 * sr));
    const gOpen = Math.exp(-1 / (0.002 * sr));   // فتح سريع
    const gClose = Math.exp(-1 / (0.12 * sr));   // إغلاق بطيء لعدم قطع نهايات الكلمات
    const holdSamples = Math.round(0.08 * sr);

    let env = 0, g = 1, hold = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      env = a > env ? envAtt * env + (1 - envAtt) * a : envRel * env + (1 - envRel) * a;
      const envDb = gainToDb(env);
      let targetDb = 0;
      if (envDb < thrDb) {
        if (hold > 0) hold--;
        else targetDb = Math.max((envDb - thrDb) * (ratio - 1), rangeDb);
      } else {
        hold = holdSamples;
      }
      const target = dbToGain(targetDb);
      g = target > g ? gOpen * g + (1 - gOpen) * target : gClose * g + (1 - gClose) * target;
      x[i] *= g;
    }
    return x;
  }

  // ------------------------------------------------------------------
  // ضاغط ديناميكي بركبة ناعمة
  // ------------------------------------------------------------------
  function compressor(x, sr, opts) {
    opts = opts || {};
    const st = levelStats(x, sr);
    const thr = opts.thresholdDb != null ? opts.thresholdDb : st.speechDb - 10;
    const ratio = opts.ratio || 3;
    const knee = opts.kneeDb || 6;
    const att = Math.exp(-1 / (0.008 * sr));
    const rel = Math.exp(-1 / (0.15 * sr));
    let lvl = 0, gr = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      lvl = a > lvl ? att * lvl + (1 - att) * a : rel * lvl + (1 - rel) * a;
      const d = gainToDb(lvl) - thr;
      let target;
      if (2 * d < -knee) target = 0;
      else if (2 * Math.abs(d) <= knee) target = (1 / ratio - 1) * Math.pow(d + knee / 2, 2) / (2 * knee);
      else target = (1 / ratio - 1) * d;
      gr = target < gr ? att * gr + (1 - att) * target : rel * gr + (1 - rel) * target;
      x[i] *= dbToGain(gr);
    }
    return x;
  }

  function normalize(x, targetDb) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (peak < 1e-9) return x;
    const g = dbToGain(targetDb == null ? -1 : targetDb) / peak;
    for (let i = 0; i < x.length; i++) x[i] *= g;
    return x;
  }

  // ------------------------------------------------------------------
  // السلسلة الكاملة
  // ------------------------------------------------------------------
  const DEFAULTS = {
    highpass: true,
    highpassFreq: 80,
    hum: 0,            // 0 = معطّل، 50 أو 60
    denoise: true,
    strength: 0.6,
    noiseProfile: 'auto',
    noiseSeconds: 1,
    gate: true,
    eq: true,
    compress: false,
    normalize: true,
  };

  function processVoice(input, sr, options, progress) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const report = progress || function () {};
    const before = levelStats(input, sr);
    let x = Float32Array.from(input);

    report(0.02, 'highpass');
    if (o.highpass) highpass(x, sr, o.highpassFreq);
    if (o.hum === 50 || o.hum === 60) removeHum(x, sr, o.hum);

    if (o.denoise) {
      x = spectralDenoise(x, sr, o, (p) => report(0.05 + p * 0.8, 'denoise'));
    }
    report(0.87, 'gate');
    if (o.gate) noiseGate(x, sr);
    report(0.91, 'eq');
    if (o.eq) voiceEQ(x, sr);
    report(0.95, 'compress');
    if (o.compress) compressor(x, sr);
    if (o.normalize) normalize(x, -1);

    const after = levelStats(x, sr);
    report(1, 'done');
    return { samples: x, stats: { before, after } };
  }

  const AudioDSP = {
    DEFAULTS,
    FFT,
    toMono,
    levelStats,
    biquadCoeffs,
    applyBiquad,
    highpass,
    removeHum,
    voiceEQ,
    spectralDenoise,
    noiseGate,
    compressor,
    normalize,
    processVoice,
    dbToGain,
    gainToDb,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AudioDSP;
  else global.AudioDSP = AudioDSP;
})(typeof self !== 'undefined' ? self : this);
