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

  /**
   * تحويل ذكي إلى قناة واحدة (Mono).
   * بعض الميكروفونات اللاسلكية ذات جهازَي الإرسال تضع كل ميكروفون في قناة؛ فإذا
   * استُخدم ميكروفون واحد تبقى القناة الأخرى صامتة أو فيها ضجيج فقط. دمجهما
   * بالتساوي يضيف ذلك الضجيج، لذا تُستخدم القناة المسموعة وحدها عندما تكون
   * الأخرى أهدأ منها بأكثر من 15dB.
   * @returns {{samples: Float32Array, mode: 'mono'|'mix'|'single', channel: number}}
   */
  function smartMono(channels) {
    if (channels.length === 1) return { samples: Float32Array.from(channels[0]), mode: 'mono', channel: 0 };
    const len = channels[0].length;
    const rms = channels.map((ch) => {
      let t = 0;
      for (let i = 0; i < len; i += 4) t += ch[i] * ch[i];
      return Math.sqrt(t / Math.max(1, Math.ceil(len / 4)));
    });
    let loud = 0;
    for (let c = 1; c < rms.length; c++) if (rms[c] > rms[loud]) loud = c;
    const others = rms.filter((_, c) => c !== loud);
    if (rms[loud] > 0 && others.every((r) => gainToDb(r) < gainToDb(rms[loud]) - 15)) {
      return { samples: Float32Array.from(channels[loud]), mode: 'single', channel: loud };
    }
    const out = new Float32Array(len);
    const k = 1 / channels.length;
    for (const ch of channels) {
      for (let i = 0; i < len; i++) out[i] += ch[i] * k;
    }
    return { samples: out, mode: 'mix', channel: -1 };
  }

  function toMono(channels) {
    return smartMono(channels).samples;
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

  /**
   * @param {boolean} [presence=true] تعزيز الوضوح العالي؛ يُعطَّل عندما يتولى
   *   تصحيح النبرة التلقائي ضبط الترددات العالية، حتى لا يتضاعف التعزيز.
   */
  function voiceEQ(x, sr, presence) {
    applyBiquad(x, biquadCoeffs('peaking', 250, sr, 1.0, -2.5));  // تقليل "الطين"
    if (presence === false) return x;
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

    // الإشارة "مُحشوّة" افتراضياً بـ N أصفار من الطرفين دون نسخها (توفير ذاكرة)
    const paddedLen = len + 2 * N;
    const at = (k) => { const t = k - N; return t >= 0 && t < len ? x[t] : 0; };
    const frames = Math.floor((paddedLen - N) / hop) + 1;

    // --- المرحلة 1: طاقة كل إطار
    const energy = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      let s = 0;
      for (let i = 0; i < N; i++) { const v = at(off + i) * win[i]; s += v * v; }
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
      for (let i = 0; i < N; i++) { re[i] = at(off + i) * win[i]; im[i] = 0; }
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
    // تراكب-جمع بحلقة دائرية بطول N: كل موضع يُكتب نهائياً فور اكتمال الإطارات التي تغطيه.
    // مع inPlace تُكتب النتيجة فوق الدخل (القراءة دائماً من مواضع لم تُكتب بعد).
    const dest = opts.inPlace ? x : new Float32Array(len);
    const acc = new Float64Array(N);
    const norm = 1 / 1.5; // مجموع مربعات نافذة Hann عند تداخل 75%
    const reportEvery = Math.max(1, Math.floor(frames / 50));

    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = at(off + i) * win[i]; im[i] = 0; }
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
      for (let i = 0; i < N; i++) acc[(off + i) % N] += re[i] * win[i];
      for (let q = off; q < off + hop; q++) {
        const t = q - N, slot = q % N;
        if (t >= 0 && t < len) dest[t] = acc[slot] * norm;
        acc[slot] = 0;
      }

      if (progress && f % reportEvery === 0) progress(f / frames);
    }

    if (progress) progress(1);
    return dest;
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
  // قياس الجهارة (Loudness) وفق ITU-R BS.1770-4 / EBU R128
  // ------------------------------------------------------------------
  function kWeightingCoeffs(sr) {
    // نفس صيغ libebur128 — تطابق معاملات ITU المنشورة عند 48kHz
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / sr);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = {
      b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0,
    };
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / sr);
    a0 = 1 + K / Q + K * K;
    const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    return { shelf, hp };
  }

  /**
   * الجهارة المتكاملة بوحدة LUFS.
   * @param {boolean} [dualMono=true] قياس الملف الأحادي كما يُسمع عند تشغيله على
   *   السماعتين (وهو ما تفعله برامج المونتاج) = +3.01dB.
   */
  function measureLoudness(x, sr, dualMono) {
    const { shelf, hp } = kWeightingCoeffs(sr);
    const block = Math.round(0.4 * sr), step = Math.round(0.1 * sr);
    if (x.length < block) return -Infinity;
    // مجموع المربعات لكل 100ms بعد K-weighting (بدون نسخ الإشارة)
    const nSteps = Math.floor(x.length / step);
    const stepSum = new Float64Array(nSteps);
    let s1 = 0, s2 = 0, h1 = 0, h2 = 0;
    for (let i = 0; i < nSteps * step; i++) {
      const v = x[i];
      let y = shelf.b0 * v + s1;
      s1 = shelf.b1 * v - shelf.a1 * y + s2;
      s2 = shelf.b2 * v - shelf.a2 * y;
      const u = y;
      y = hp.b0 * u + h1;
      h1 = hp.b1 * u - hp.a1 * y + h2;
      h2 = hp.b2 * u - hp.a2 * y;
      stepSum[(i / step) | 0] += y * y;
    }
    const offset = -0.691 + (dualMono === false ? 0 : 10 * Math.log10(2));
    const z = [];
    for (let b = 0; b + 4 <= nSteps; b++) {
      z.push((stepSum[b] + stepSum[b + 1] + stepSum[b + 2] + stepSum[b + 3]) / (4 * step));
    }
    const L = (ms) => offset + 10 * Math.log10(ms);
    const abs = z.filter((v) => v > 0 && L(v) > -70);
    if (!abs.length) return -Infinity;
    const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((v) => L(v) > rel);
    return L(gated.reduce((a, b) => a + b, 0) / gated.length);
  }

  /**
   * محدِّد قمم (Limiter) بنظرة استباقية 5ms: لا تتجاوز أي عيّنة ceilingDb،
   * مع انتقالات ناعمة دون تقطيع. يعمل بتمريرة واحدة وذاكرة إضافية صغيرة جداً.
   *
   *   m[i] = أصغر كسب مطلوب في النافذة [i, i+L)      (طابور رتيب)
   *   s[i] = متوسط m في [i-L+1, i]                   (≤ الكسب المطلوب عند كل قمة)
   *   r[i] = s[i] عند الهبوط، وصعود ناعم (release) عند الارتفاع
   */
  function limiter(x, sr, ceilingDb) {
    const c = dbToGain(ceilingDb == null ? -1 : ceilingDb);
    const n = x.length;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (peak <= c) return x;
    const L = Math.max(1, Math.round(0.005 * sr));
    const R = L + 1;                         // حجم الحلقات الدائرية
    const qIdx = new Int32Array(R), qVal = new Float32Array(R);
    let qh = 0, qt = 0, qn = 0;              // طابور رتيب دائري
    const mRing = new Float32Array(L).fill(1);
    let sum = L;                             // ما قبل البداية يُعامل ككسب = 1
    const rel = Math.exp(-1 / (0.08 * sr));
    let r = 1;
    for (let j = 0; j < n + L - 1; j++) {
      if (j < n) {
        const a = Math.abs(x[j]);
        const g = a > c ? c / a : 1;
        while (qn > 0 && qVal[(qt - 1 + R) % R] >= g) { qt = (qt - 1 + R) % R; qn--; }
        qIdx[qt] = j; qVal[qt] = g; qt = (qt + 1) % R; qn++;
      }
      const i = j - L + 1;
      if (i < 0) continue;
      while (qIdx[qh] < i) { qh = (qh + 1) % R; qn--; }
      const m = qVal[qh];
      const slot = i % L;
      sum += m - mRing[slot];
      mRing[slot] = m;
      const avg = sum / L;
      r = avg < r ? avg : avg + (r - avg) * rel;
      x[i] *= r;
    }
    return x;
  }

  /** ضبط الجهارة على هدف بوحدة LUFS مع منع تجاوز القمم. */
  function normalizeLoudness(x, sr, targetLufs, ceilingDb) {
    const before = measureLoudness(x, sr);
    if (!Number.isFinite(before)) return { before, gainDb: 0 };
    const ceil = ceilingDb == null ? -1 : ceilingDb;
    let gainDb = clamp(targetLufs - before, -40, 40);
    let g = dbToGain(gainDb);
    for (let i = 0; i < x.length; i++) x[i] *= g;
    limiter(x, sr, ceil);
    // تمريرة تصحيح: المحدِّد يخفض الجهارة قليلاً، فنعوّض الفرق (حتى 3dB) مرة واحدة
    const miss = targetLufs - measureLoudness(x, sr);
    if (Math.abs(miss) > 0.1 && Math.abs(miss) < 3) {
      g = dbToGain(miss);
      for (let i = 0; i < x.length; i++) x[i] *= g;
      limiter(x, sr, ceil);
      gainDb += miss;
    }
    return { before, gainDb };
  }

  // ------------------------------------------------------------------
  // إعادة التشكيل (Resampling) — Windowed-sinc بجدول معامِلات مسبق الحساب
  // ------------------------------------------------------------------
  const resampleTables = new Map();
  function resampleKernel(cutoff, width, res) {
    const key = cutoff + ':' + width;
    if (resampleTables.has(key)) return resampleTables.get(key);
    const size = Math.ceil(width * res) + 2;
    const table = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const d = i / res;
      if (d >= width) { table[i] = 0; continue; }
      const xx = d * cutoff;
      const sinc = xx === 0 ? 1 : Math.sin(Math.PI * xx) / (Math.PI * xx);
      const w = d / width; // نافذة Blackman
      const win = 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w);
      table[i] = cutoff * sinc * win;
    }
    resampleTables.set(key, table);
    return table;
  }

  function resample(x, fromSr, toSr) {
    if (fromSr === toSr) return Float32Array.from(x);
    const ratio = toSr / fromSr;
    const outLen = Math.round(x.length * ratio);
    const out = new Float32Array(outLen);
    const cutoff = Math.min(1, ratio) * 0.95;   // حماية من التشوه (aliasing) عند خفض المعدل
    const width = Math.ceil(16 / cutoff);
    const RES = 512;
    const table = resampleKernel(cutoff, width, RES);
    const n = x.length;
    for (let i = 0; i < outLen; i++) {
      const t = i / ratio;
      const c = Math.floor(t);
      const j0 = Math.max(0, c - width + 1);
      const j1 = Math.min(n - 1, c + width);
      let s = 0;
      for (let j = j0; j <= j1; j++) {
        const pos = Math.abs(t - j) * RES;
        const k = pos | 0;
        const frac = pos - k;
        s += x[j] * (table[k] + (table[k + 1] - table[k]) * frac);
      }
      out[i] = s;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // إزالة الضوضاء بالذكاء الاصطناعي — RNNoise (شبكة عصبية متكررة)
  // ------------------------------------------------------------------
  const RNN_SR = 48000;
  const RNN_FRAME = 480;      // 10ms عند 48kHz
  const RNN_DELAY = 480;      // تأخير الخوارزمية بالعينات (يُعوَّض)

  /**
   * @param {Float32Array} x
   * @param {number} sr
   * @param {object} mod  وحدة RNNoise WebAssembly بعد تحميلها
   * @param {object} opts strength: 0..1 (يحدد نسبة مزج الصوت الأصلي)
   * @param {function} [progress]
   * @returns {{samples: Float32Array, vad: Float32Array}}
   */
  function rnnoiseDenoise(x, sr, mod, opts, progress) {
    opts = opts || {};
    const strength = clamp(opts.strength == null ? 0.6 : opts.strength, 0, 1);
    const report = progress || function () {};
    const len = x.length;
    if (len === 0) return { samples: new Float32Array(0), vad: new Float32Array(0) };

    const x48 = sr === RNN_SR ? x : resample(x, sr, RNN_SR);
    report(0.15);
    const n = x48.length;
    const total = n + RNN_DELAY;
    const frames = Math.ceil(total / RNN_FRAME);
    const dry = dbToGain(-(6 + 34 * strength)); // نسبة الصوت الأصلي الممزوجة (لطبيعية الصوت)
    // عند 48kHz مع inPlace يُكتب الناتج فوق الدخل نفسه: كل عيّنة تُقرأ قبل أن تُستبدل
    // (الكتابة عند t = k - 480 بينما القراءة دائماً عند k ≥ t)
    const y48 = (sr === RNN_SR && opts.inPlace) ? x : new Float32Array(n);
    const vad = new Float32Array(frames);

    const st = mod._rnnoise_create(0);
    const inPtr = mod._malloc(RNN_FRAME * 4);
    const outPtr = mod._malloc(RNN_FRAME * 4);
    const SCALE = 32768; // RNNoise يتوقع عينات بمدى int16
    const reportEvery = Math.max(1, Math.floor(frames / 40));
    try {
      for (let f = 0; f < frames; f++) {
        const heap = mod.HEAPF32; // قد تتغير عند نمو الذاكرة
        const ib = inPtr >> 2, ob = outPtr >> 2, off = f * RNN_FRAME;
        for (let i = 0; i < RNN_FRAME; i++) {
          const k = off + i;
          heap[ib + i] = k < n ? x48[k] * SCALE : 0;
        }
        vad[f] = mod._rnnoise_process_frame(st, outPtr, inPtr);
        const h2 = mod.HEAPF32;
        // تعويض التأخير أثناء الكتابة مباشرة: عيّنة الخرج k تقابل عيّنة الدخل k - RNN_DELAY
        for (let i = 0; i < RNN_FRAME; i++) {
          const t = off + i - RNN_DELAY;
          if (t >= 0 && t < n) y48[t] = (1 - dry) * (h2[ob + i] / SCALE) + dry * x48[t];
        }
        if (f % reportEvery === 0) report(0.15 + 0.7 * (f / frames));
      }
    } finally {
      mod._rnnoise_destroy(st);
      mod._free(inPtr);
      mod._free(outPtr);
    }

    report(0.9);
    let y = sr === RNN_SR ? y48 : resample(y48, RNN_SR, sr);
    if (y.length !== len) { const t = new Float32Array(len); t.set(y.subarray(0, len)); y = t; }
    report(1);
    return { samples: y, vad };
  }

  // ------------------------------------------------------------------
  // تحليل الكلام: توزيع الترددات (LTAS) ودرجة الصوت (Pitch)
  // ------------------------------------------------------------------
  const TONE_BANDS = [400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];

  /**
   * متوسط طيف الكلام على المدى الطويل بنطاقات ثلث أوكتاف، نسبةً إلى متوسط
   * نطاقات 400–630Hz. يُحسب على أعلى 50% من المقاطع طاقةً (الكلام فقط).
   * @returns {number[]|null} dB لكل تردد في TONE_BANDS، أو null إن لم يكفِ الكلام
   */
  function speechLTAS(x, sr) {
    const N = 8192, hop = N / 2;
    if (x.length < N * 4) return null;
    const blocks = [];
    for (let off = 0; off + N <= x.length; off += hop) {
      let e = 0;
      for (let i = off; i < off + N; i += 4) e += x[i] * x[i];
      blocks.push([off, e]);
    }
    const sorted = blocks.map((b) => b[1]).sort((a, b) => a - b);
    const thr = sorted[Math.floor(sorted.length * 0.5)];
    let chosen = blocks.filter((b) => b[1] >= thr && b[1] > 0);
    if (chosen.length < 4) return null;
    // للتسجيلات الطويلة يكفي ~400 مقطع موزعة على الملف
    if (chosen.length > 400) { const step = chosen.length / 400; chosen = Array.from({ length: 400 }, (_, i) => chosen[Math.floor(i * step)]); }
    const fft = getFFT(N);
    const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2 + 1);
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    for (const [off] of chosen) {
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft.transform(re, im, false);
      for (let k = 0; k <= N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    }
    const band = (fc) => {
      const lo = fc / Math.pow(2, 1 / 6), hi = Math.min(fc * Math.pow(2, 1 / 6), sr * 0.49);
      let s = 0;
      for (let k = Math.ceil((lo * N) / sr); k <= Math.floor((hi * N) / sr); k++) s += P[k];
      return 10 * Math.log10(s + 1e-30);
    };
    const lv = TONE_BANDS.map((fc) => (fc * Math.pow(2, -1 / 6) < sr * 0.49 ? band(fc) : NaN));
    const ref = (lv[0] + lv[1] + lv[2]) / 3;
    return lv.map((v) => v - ref);
  }

  /** تقدير درجة الصوت (F0) بالارتباط الذاتي على إشارة مخفّضة إلى 8kHz. */
  function estimatePitch(x, sr) {
    const dsr = 8000;
    const y = resampleLight(x, sr, dsr);
    const F = 512, minL = Math.round(dsr / 400), maxL = Math.round(dsr / 55);
    const frames = [];
    for (let off = 0; off + F + maxL <= y.length; off += F) {
      let e = 0;
      for (let i = off; i < off + F; i++) e += y[i] * y[i];
      frames.push([off, e]);
    }
    if (!frames.length) return null;
    const es = frames.map((f) => f[1]).sort((a, b) => a - b);
    const thr = es[Math.floor(es.length * 0.6)];
    let voiced = frames.filter((f) => f[1] >= thr && f[1] > 0);
    if (voiced.length > 300) { const st = voiced.length / 300; voiced = Array.from({ length: 300 }, (_, i) => voiced[Math.floor(i * st)]); }
    const f0s = [];
    for (const [off] of voiced) {
      let best = 0, bl = 0;
      for (let L = minL; L <= maxL; L++) {
        let c = 0, n1 = 0, n2 = 0;
        for (let i = off; i < off + F; i++) { c += y[i] * y[i + L]; n1 += y[i] * y[i]; n2 += y[i + L] * y[i + L]; }
        const r = c / Math.sqrt(n1 * n2 + 1e-20);
        if (r > best) { best = r; bl = L; }
      }
      if (best > 0.6) f0s.push(dsr / bl);
    }
    if (f0s.length < 5) return null;
    f0s.sort((a, b) => a - b);
    return { median: f0s[Math.floor(f0s.length / 2)], p10: f0s[Math.floor(f0s.length * 0.1)], frames: f0s.length };
  }

  /** خفض معدل سريع (للتحليل فقط، لا للصوت المسموع) — دون نسخ الإشارة كاملة. */
  function resampleLight(x, sr, to) {
    if (sr <= to) return x;
    const c = biquadCoeffs('lowpass', to * 0.45, sr, 0.7071);
    const r = sr / to, n = Math.floor(x.length / r), out = new Float32Array(n);
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0, next = 0, j = 0;
    for (let i = 0; i < x.length && j < n; i++) {
      const v = x[i];
      let y = c.b0 * v + a1; a1 = c.b1 * v - c.a1 * y + a2; a2 = c.b2 * v - c.a2 * y;
      const u = y;
      y = c.b0 * u + b1; b1 = c.b1 * u - c.a1 * y + b2; b2 = c.b2 * u - c.a2 * y;
      if (i >= next) { out[j++] = y; next = Math.floor(j * r); }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // تصحيح النبرة التلقائي
  // ------------------------------------------------------------------
  /**
   * النبرة المرجعية: توزيع ترددات صوت المستخدم نفسه كما التقطه ميكروفون
   * الهاتف (تسجيل مرجعي 30 ثانية)، مُنعَّماً. القيم بالـ dB لكل نطاق في TONE_BANDS.
   */
  const TONE_TARGET_VALUES = [2, 0.4, -3.3, -7.4, -10.8, -13.1, -14.4, -15.8, -19.5, -20.7, -15, -11.1, -12.7, -15.9, -19.2, -20];

  /**
   * منحنى التصحيح = الهدف − المقاس، بعد التنعيم والحدود:
   * لا تغيير تحت 800Hz، وتعزيز حتى +12dB، وتخفيض حتى −6dB.
   * @returns {{points: Array<[number, number]>, measured: number[]}|null}
   */
  function toneCorrection(x, sr, amount, target) {
    const tgt = target || TONE_TARGET_VALUES;
    const m = speechLTAS(x, sr);
    if (!m) return null;
    const diff = TONE_BANDS.map((f, j) => (Number.isFinite(m[j]) ? tgt[j] - m[j] : 0));
    const sm = diff.map((d, j) => (diff[Math.max(0, j - 1)] + 2 * d + diff[Math.min(diff.length - 1, j + 1)]) / 4);
    const a = clamp(amount == null ? 1 : amount, 0, 1);
    const points = TONE_BANDS.map((f, j) => {
      let g = f < 800 ? 0 : f < 1000 ? sm[j] * 0.5 : sm[j];
      g = clamp(g, -6, 12) * a;
      return [f, g];
    });
    return { points, measured: m };
  }

  /** معادل بمنحنى حر (تداخل لوغاريتمي بين النقاط) — مرشح ثابت بطور صفري عبر STFT. */
  function applyEqCurve(x, sr, points, inPlace) {
    const N = 2048, hop = 512, len = x.length;
    const fft = getFFT(N);
    const g = new Float64Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) {
      const f = Math.max((k * sr) / N, 1);
      let db;
      if (f <= points[0][0]) db = points[0][1];
      else if (f >= points[points.length - 1][0]) db = points[points.length - 1][1];
      else {
        for (let j = 0; j < points.length - 1; j++) {
          if (f >= points[j][0] && f <= points[j + 1][0]) {
            const t = Math.log(f / points[j][0]) / Math.log(points[j + 1][0] / points[j][0]);
            db = points[j][1] + t * (points[j + 1][1] - points[j][1]);
            break;
          }
        }
      }
      g[k] = dbToGain(db);
    }
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const dest = inPlace ? x : new Float32Array(len);
    const acc = new Float64Array(N);
    const norm = 1 / 1.5;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let off = -N; off < len; off += hop) {
      for (let i = 0; i < N; i++) { const t = off + i; re[i] = (t >= 0 && t < len ? x[t] : 0) * win[i]; im[i] = 0; }
      fft.transform(re, im, false);
      for (let k = 0; k <= N / 2; k++) {
        re[k] *= g[k]; im[k] *= g[k];
        if (k > 0 && k < N / 2) { re[N - k] *= g[k]; im[N - k] *= g[k]; }
      }
      fft.transform(re, im, true);
      for (let i = 0; i < N; i++) acc[(off + i + N) % N] += re[i] * win[i];
      for (let t = off; t < off + hop; t++) {
        const slot = (t + N) % N;
        if (t >= 0 && t < len) dest[t] = acc[slot] * norm;
        acc[slot] = 0;
      }
    }
    return dest;
  }

  // ------------------------------------------------------------------
  // السلسلة الكاملة
  // ------------------------------------------------------------------
  const DEFAULTS = {
    highpass: true,
    highpassFreq: 'auto',  // 'auto' = تحت درجة صوت المتحدث (40–80Hz)، أو رقم بالهرتز
    tone: 1,               // تصحيح النبرة التلقائي: 0 = معطّل، 1 = كامل
    hum: 0,            // 0 = معطّل، 50 أو 60
    denoise: true,
    engine: 'hybrid',  // 'ai' | 'hybrid' | 'spectral'
    rnnoise: null,     // وحدة RNNoise المحمّلة (مطلوبة لـ ai و hybrid)
    strength: 0.6,
    noiseProfile: 'auto',
    noiseSeconds: 1,
    gate: true,
    eq: true,
    compress: false,
    normalize: true,       // تطبيع القمة إلى -1dBFS (يُستخدم عندما loudness = null)
    loudness: null,        // هدف الجهارة LUFS (مثل -16)؛ يتقدم على normalize
    inPlace: false,        // معالجة المصفوفة المُدخلة مباشرة لتوفير الذاكرة
  };

  function processVoice(input, sr, options, progress) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const report = progress || function () {};
    const before = levelStats(input, sr);
    let x = o.inPlace ? input : Float32Array.from(input);

    report(0.01, 'analyze');
    const pitch = estimatePitch(x, sr);
    let hpFreq = o.highpassFreq;
    if (hpFreq === 'auto') hpFreq = pitch ? clamp(Math.round(pitch.p10 * 0.75), 40, 80) : 80;

    report(0.02, 'highpass');
    if (o.highpass) highpass(x, sr, hpFreq);
    if (o.hum === 50 || o.hum === 60) removeHum(x, sr, o.hum);

    let tone = null, toneApplied = false;
    if (o.tone > 0) {
      report(0.03, 'tone');
      tone = toneCorrection(x, sr, o.tone);
      if (tone && tone.points.some((pt) => Math.abs(pt[1]) > 0.5)) { x = applyEqCurve(x, sr, tone.points, true); toneApplied = true; }
    }

    let engineUsed = 'none';
    if (o.denoise) {
      let engine = o.engine;
      if ((engine === 'ai' || engine === 'hybrid') && !o.rnnoise) engine = 'spectral'; // النموذج غير متاح
      if (engine === 'ai' || engine === 'hybrid') {
        const span = engine === 'hybrid' ? 0.6 : 0.8;
        const own = Object.assign({}, o, { inPlace: true }); // x مملوكة لهذه الدالة
        x = rnnoiseDenoise(x, sr, o.rnnoise, own, (p) => report(0.05 + p * span, 'ai')).samples;
        if (engine === 'hybrid') {
          // تمريرة طيفية خفيفة لإزالة بقايا الضوضاء الثابتة بعد النموذج
          const so = Object.assign({}, o, { strength: o.strength * 0.5, noiseProfile: 'auto', inPlace: true });
          x = spectralDenoise(x, sr, so, (p) => report(0.65 + p * 0.2, 'denoise'));
        }
      } else {
        x = spectralDenoise(x, sr, Object.assign({}, o, { inPlace: true }), (p) => report(0.05 + p * 0.8, 'denoise'));
      }
      engineUsed = engine;
    }
    report(0.87, 'gate');
    if (o.gate) noiseGate(x, sr);
    report(0.91, 'eq');
    if (o.eq) voiceEQ(x, sr, !toneApplied);
    report(0.95, 'compress');
    if (o.compress) compressor(x, sr);
    report(0.97, 'level');
    if (o.loudness != null && Number.isFinite(o.loudness)) normalizeLoudness(x, sr, o.loudness, -1);
    else if (o.normalize) normalize(x, -1);

    const after = levelStats(x, sr);
    after.lufs = measureLoudness(x, sr);
    report(1, 'done');
    const toneMax = tone ? Math.max(...tone.points.map((pt) => pt[1])) : 0;
    return {
      samples: x,
      stats: { before, after, engine: engineUsed, pitch: pitch && pitch.median, highpassHz: o.highpass ? hpFreq : null, toneMaxDb: toneMax },
    };
  }

  const AudioDSP = {
    DEFAULTS,
    FFT,
    toMono,
    smartMono,
    TONE_BANDS,
    speechLTAS,
    estimatePitch,
    toneCorrection,
    applyEqCurve,
    levelStats,
    measureLoudness,
    kWeightingCoeffs,
    limiter,
    normalizeLoudness,
    biquadCoeffs,
    applyBiquad,
    highpass,
    removeHum,
    voiceEQ,
    spectralDenoise,
    resample,
    rnnoiseDenoise,
    RNN_SR,
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
