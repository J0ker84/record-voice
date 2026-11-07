/* صوت نقي — واجهة التطبيق: التسجيل، العرض، المعالجة، المقارنة والتحميل */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const els = {
    recordBtn: $('#recordBtn'), timer: $('#timer'), recStatus: $('#recStatus'),
    meterFill: $('#meterFill'), liveCanvas: $('#liveCanvas'), fileInput: $('#fileInput'),
    browserNs: $('#browserNs'), strength: $('#strength'), strengthOut: $('#strengthOut'),
    noiseProfile: $('#noiseProfile'), hum: $('#hum'), optHighpass: $('#optHighpass'),
    optGate: $('#optGate'), optEq: $('#optEq'), optCompress: $('#optCompress'),
    optNormalize: $('#optNormalize'), processBtn: $('#processBtn'),
    progressWrap: $('#progressWrap'), progressFill: $('#progressFill'), progressText: $('#progressText'),
    origCanvas: $('#origCanvas'), procCanvas: $('#procCanvas'), origAudio: $('#origAudio'),
    procAudio: $('#procAudio'), origMeta: $('#origMeta'), procMeta: $('#procMeta'),
    downloadOrig: $('#downloadOrig'), downloadProc: $('#downloadProc'),
    stats: $('#stats'), emptyHint: $('#emptyHint'), toast: $('#toast'),
  };

  const state = {
    original: null,   // { samples: Float32Array, sampleRate, name }
    processed: null,  // { samples: Float32Array, sampleRate }
    origUrl: null,
    procUrl: null,
    processing: false,
  };

  // ------------------------------------------------------------------
  // أدوات عامة
  // ------------------------------------------------------------------
  let audioCtx = null;
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  let toastTimer;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', !!isError);
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), isError ? 6000 : 3000);
  }

  const fmtTime = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function baseName(name) {
    return (name || 'audio').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
  }

  function extFromMime(mime) {
    if (/webm/.test(mime)) return 'webm';
    if (/mp4|aac|m4a/.test(mime)) return 'm4a';
    if (/ogg/.test(mime)) return 'ogg';
    if (/wav/.test(mime)) return 'wav';
    if (/mpeg|mp3/.test(mime)) return 'mp3';
    return 'audio';
  }

  /** تحويل عينات Float32 إلى ملف WAV بدقة 16 بت. */
  function encodeWav(samples, sampleRate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function decodeAudio(arrayBuffer) {
    const ctx = getCtx();
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject); // Safari القديم يدعم الصيغة بالدوال فقط
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  // ------------------------------------------------------------------
  // رسم الموجة الصوتية
  // ------------------------------------------------------------------
  function sizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { w, h, dpr };
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawWaveform(canvas, samples, color) {
    const { w, h } = sizeCanvas(canvas);
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    g.fillStyle = cssVar('--border');
    g.fillRect(0, mid, w, 1);
    if (!samples || !samples.length) return;
    g.fillStyle = color;
    const per = samples.length / w;
    for (let x = 0; x < w; x++) {
      const start = Math.floor(x * per);
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((x + 1) * per)));
      let min = 1, max = -1;
      for (let i = start; i < end; i++) {
        const s = samples[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      const y1 = mid - max * mid * 0.95;
      const y2 = mid - min * mid * 0.95;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  function redrawAll() {
    drawWaveform(els.origCanvas, state.original && state.original.samples, cssVar('--wave-orig'));
    drawWaveform(els.procCanvas, state.processed && state.processed.samples, cssVar('--wave-proc'));
    if (!rec.active) drawWaveform(els.liveCanvas, null, '');
  }
  let resizeRaf;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(redrawAll);
  });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', redrawAll);
  }

  // ------------------------------------------------------------------
  // التسجيل
  // ------------------------------------------------------------------
  const rec = { active: false, recorder: null, stream: null, chunks: [], analyser: null, source: null, raf: 0, startedAt: 0, timerId: 0 };

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('متصفحك لا يدعم التسجيل. جرّب Chrome أو Safari أو Firefox حديث.', true);
      return;
    }
    if (!window.isSecureContext) {
      toast('التسجيل يتطلب فتح التطبيق عبر https أو localhost.', true);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: els.browserNs.checked,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      toast(denied ? 'تم رفض إذن الميكروفون. اسمح بالوصول من إعدادات المتصفح.' : 'تعذّر الوصول إلى الميكروفون: ' + (err && err.message), true);
      return;
    }

    const mime = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : undefined);
    } catch (e) {
      recorder = new MediaRecorder(stream);
    }

    rec.active = true;
    rec.stream = stream;
    rec.recorder = recorder;
    rec.chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    recorder.onstop = onRecordingStopped;
    recorder.start(250);

    // مؤشر المستوى والموجة الحية
    const ctx = getCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    rec.source = ctx.createMediaStreamSource(stream);
    rec.analyser = ctx.createAnalyser();
    rec.analyser.fftSize = 2048;
    rec.source.connect(rec.analyser);
    drawLive();

    rec.startedAt = performance.now();
    els.timer.textContent = '00:00';
    rec.timerId = setInterval(() => { els.timer.textContent = fmtTime((performance.now() - rec.startedAt) / 1000); }, 250);

    els.recordBtn.classList.add('recording');
    els.recordBtn.setAttribute('aria-label', 'أوقف التسجيل');
    els.recStatus.textContent = 'جارٍ التسجيل… اضغط مرة أخرى للإيقاف';
    els.fileInput.disabled = true;
    els.processBtn.disabled = true;
  }

  function stopRecording() {
    if (!rec.active) return;
    rec.active = false;
    clearInterval(rec.timerId);
    cancelAnimationFrame(rec.raf);
    try { rec.recorder.state !== 'inactive' && rec.recorder.stop(); } catch (e) { /* تجاهل */ }
    if (rec.source) rec.source.disconnect();
    rec.stream.getTracks().forEach((t) => t.stop());
    els.meterFill.style.width = '0';
    els.recordBtn.classList.remove('recording');
    els.recordBtn.setAttribute('aria-label', 'ابدأ التسجيل');
    els.recStatus.textContent = 'جارٍ تجهيز التسجيل…';
    els.fileInput.disabled = false;
  }

  async function onRecordingStopped() {
    const type = (rec.recorder && rec.recorder.mimeType) || rec.chunks[0]?.type || 'audio/webm';
    const blob = new Blob(rec.chunks, { type });
    rec.chunks = [];
    if (!blob.size) {
      els.recStatus.textContent = 'لم يُسجَّل أي صوت.';
      return;
    }
    await loadBlob(blob, 'تسجيل-' + stamp() + '.' + extFromMime(type));
    els.recStatus.textContent = 'تم التسجيل ✔ يمكنك الآن تنقية الصوت';
  }

  function drawLive() {
    const analyser = rec.analyser;
    const data = new Float32Array(analyser.fftSize);
    const canvas = els.liveCanvas;
    const color = cssVar('--danger') || '#dc2626';
    const tick = () => {
      if (!rec.active) return;
      analyser.getFloatTimeDomainData(data);
      const { w, h } = sizeCanvas(canvas);
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, w, h);
      g.strokeStyle = color;
      g.lineWidth = Math.max(1.5, (window.devicePixelRatio || 1) * 1.5);
      g.beginPath();
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * w;
        const y = h / 2 - data[i] * h * 0.45;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        peak = Math.max(peak, Math.abs(data[i]));
      }
      g.stroke();
      const db = 20 * Math.log10(Math.max(peak, 1e-6));
      els.meterFill.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
      rec.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  els.recordBtn.addEventListener('click', () => {
    if (rec.active) stopRecording(); else startRecording();
  });

  // ------------------------------------------------------------------
  // تحميل الصوت (من التسجيل أو من ملف)
  // ------------------------------------------------------------------
  async function loadBlob(blob, name) {
    try {
      const audio = await decodeAudio(await blob.arrayBuffer());
      const channels = [];
      for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
      const samples = AudioDSP.toMono(channels);

      if (state.origUrl) URL.revokeObjectURL(state.origUrl);
      state.origUrl = URL.createObjectURL(blob);
      state.original = { samples, sampleRate: audio.sampleRate, name };
      clearProcessed();

      els.origAudio.src = state.origUrl;
      els.downloadOrig.href = state.origUrl;
      els.downloadOrig.download = name;
      els.downloadOrig.hidden = false;
      els.timer.textContent = fmtTime(audio.duration);
      els.origMeta.textContent = `${fmtTime(audio.duration)} · ${(audio.sampleRate / 1000).toFixed(1)} kHz`;
      els.emptyHint.hidden = true;
      els.processBtn.disabled = false;
      redrawAll();
    } catch (err) {
      console.error(err);
      toast('تعذّرت قراءة الملف الصوتي. تأكد أنه بصيغة مدعومة (WAV, MP3, M4A, OGG, WEBM).', true);
    }
  }

  function clearProcessed() {
    state.processed = null;
    if (state.procUrl) URL.revokeObjectURL(state.procUrl);
    state.procUrl = null;
    els.procAudio.removeAttribute('src');
    els.procAudio.load();
    els.downloadProc.hidden = true;
    els.procMeta.textContent = '';
    els.stats.hidden = true;
  }

  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (!file) return;
    els.recStatus.textContent = 'جارٍ قراءة الملف…';
    await loadBlob(file, file.name);
    els.recStatus.textContent = state.original ? 'تم تحميل الملف ✔' : 'اضغط الزر الأحمر لبدء التسجيل';
    els.fileInput.value = '';
  });

  // ------------------------------------------------------------------
  // المعالجة
  // ------------------------------------------------------------------
  els.strength.addEventListener('input', () => { els.strengthOut.textContent = els.strength.value + '%'; });

  function readOptions() {
    const s = Number(els.strength.value) / 100;
    return {
      denoise: s > 0,
      strength: s,
      noiseProfile: els.noiseProfile.value,
      noiseSeconds: 1,
      hum: Number(els.hum.value),
      highpass: els.optHighpass.checked,
      gate: els.optGate.checked,
      eq: els.optEq.checked,
      compress: els.optCompress.checked,
      normalize: els.optNormalize.checked,
    };
  }

  function setProgress(p) {
    const pct = Math.round(p * 100);
    els.progressFill.style.width = pct + '%';
    els.progressText.textContent = pct + '%';
  }

  let worker = null;
  function getWorker() {
    if (worker === null) {
      try { worker = new Worker('dsp-worker.js'); } catch (e) { worker = false; } // file:// لا يدعم Workers
    }
    return worker;
  }

  function runProcessing(samples, sampleRate, options) {
    const w = getWorker();
    if (!w) {
      // تشغيل على الخيط الرئيسي كحل بديل
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try { resolve(AudioDSP.processVoice(samples, sampleRate, options, setProgress)); } catch (e) { reject(e); }
        }, 30);
      });
    }
    return new Promise((resolve, reject) => {
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') setProgress(m.value);
        else if (m.type === 'done') resolve({ samples: m.samples, stats: m.stats });
        else if (m.type === 'error') reject(new Error(m.message));
      };
      w.onerror = (e) => { e.preventDefault(); worker = false; reject(new Error(e.message || 'worker error')); };
      const copy = Float32Array.from(samples);
      w.postMessage({ samples: copy, sampleRate, options }, [copy.buffer]);
    });
  }

  els.processBtn.addEventListener('click', async () => {
    if (!state.original || state.processing) return;
    state.processing = true;
    els.processBtn.disabled = true;
    els.processBtn.textContent = '⏳ جارٍ التنقية…';
    els.progressWrap.hidden = false;
    setProgress(0);
    const t0 = performance.now();
    try {
      const { samples, sampleRate } = state.original;
      let result;
      try {
        result = await runProcessing(samples, sampleRate, readOptions());
      } catch (err) {
        if (worker === false) result = AudioDSP.processVoice(samples, sampleRate, readOptions(), setProgress);
        else throw err;
      }
      clearProcessed();
      state.processed = { samples: result.samples, sampleRate };
      state.procUrl = URL.createObjectURL(encodeWav(result.samples, sampleRate));
      els.procAudio.src = state.procUrl;
      els.downloadProc.href = state.procUrl;
      els.downloadProc.download = baseName(state.original.name) + '-نقي.wav';
      els.downloadProc.hidden = false;
      els.procMeta.textContent = `تمت في ${((performance.now() - t0) / 1000).toFixed(1)} ث`;
      showStats(result.stats);
      redrawAll();
      toast('تمت التنقية ✨ استمع وقارن بين النسختين');
      els.procAudio.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      console.error(err);
      toast('حدث خطأ أثناء المعالجة: ' + err.message, true);
    } finally {
      state.processing = false;
      els.processBtn.disabled = false;
      els.processBtn.textContent = '✨ نقِّ الصوت';
      setTimeout(() => { els.progressWrap.hidden = true; }, 600);
    }
  });

  function showStats(st) {
    if (!st) return;
    const b = st.before, a = st.after;
    const gain = a.snrDb - b.snrDb;
    const items = [
      ['نسبة الكلام للضوضاء قبل', b.snrDb.toFixed(1) + ' dB', ''],
      ['نسبة الكلام للضوضاء بعد', a.snrDb.toFixed(1) + ' dB', 'good'],
      ['مقدار التحسّن', (gain >= 0 ? '+' : '−') + Math.abs(gain).toFixed(1) + ' dB', gain >= 0 ? 'good' : ''],
    ];
    els.stats.innerHTML = items.map(([label, value, cls]) =>
      `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`).join('');
    els.stats.hidden = false;
  }

  // تشغيل نسخة واحدة فقط في كل مرة لتسهيل المقارنة
  els.origAudio.addEventListener('play', () => els.procAudio.pause());
  els.procAudio.addEventListener('play', () => els.origAudio.pause());

  // ------------------------------------------------------------------
  // PWA: العمل بدون إنترنت
  // ------------------------------------------------------------------
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  redrawAll();
})();
