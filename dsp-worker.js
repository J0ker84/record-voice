/* معالجة الصوت في خيط منفصل حتى لا تتجمد الواجهة */
importScripts('dsp.js');

self.onmessage = (e) => {
  const { samples, sampleRate, options } = e.data;
  try {
    const result = self.AudioDSP.processVoice(samples, sampleRate, options, (p, stage) => {
      self.postMessage({ type: 'progress', value: p, stage });
    });
    self.postMessage({ type: 'done', samples: result.samples, stats: result.stats }, [result.samples.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
