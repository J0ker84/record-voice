/* معالجة الصوت في خيط منفصل حتى لا تتجمد الواجهة */
importScripts('dsp.js', 'vendor/rnnoise/rnnoise.js');

// تحميل نموذج RNNoise (WebAssembly) مرة واحدة فقط ثم إعادة استخدامه
let rnnoisePromise = null;
function loadRNNoise() {
  if (!rnnoisePromise) {
    rnnoisePromise = fetch('vendor/rnnoise/rnnoise.wasm')
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => self.createRNNWasmModule({ wasmBinary: new Uint8Array(buf) }))
      .catch((err) => {
        rnnoisePromise = null; // السماح بإعادة المحاولة لاحقاً
        throw err;
      });
  }
  return rnnoisePromise;
}

self.onmessage = async (e) => {
  const { samples, sampleRate, options } = e.data;
  try {
    const opts = Object.assign({}, options);
    if (opts.denoise && (opts.engine === 'ai' || opts.engine === 'hybrid')) {
      self.postMessage({ type: 'progress', value: 0.01, stage: 'load-model' });
      try {
        opts.rnnoise = await loadRNNoise();
      } catch (err) {
        self.postMessage({ type: 'warn', message: 'تعذّر تحميل نموذج الذكاء الاصطناعي، تم استخدام الطريقة الطيفية بدلاً منه.' });
      }
    }
    const result = self.AudioDSP.processVoice(samples, sampleRate, opts, (p, stage) => {
      self.postMessage({ type: 'progress', value: p, stage });
    });
    self.postMessage({ type: 'done', samples: result.samples, stats: result.stats }, [result.samples.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
