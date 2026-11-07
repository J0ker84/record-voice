# RNNoise (WebAssembly)

| | |
|---|---|
| النموذج | [RNNoise](https://github.com/xiph/rnnoise) — Xiph.Org / Mozilla — رخصة BSD-3-Clause (`COPYING-rnnoise`) |
| نسخة WebAssembly | [`@jitsi/rnnoise-wasm@0.2.1`](https://www.npmjs.com/package/@jitsi/rnnoise-wasm) — رخصة Apache-2.0 (`LICENSE-jitsi-rnnoise-wasm`) |
| `rnnoise.wasm` | منسوخ كما هو (SHA-256: `677147b9248aedc0a00de79dc090d1ecead37c08c8bb773a790da16109d2c487`) |
| `rnnoise.js` | `dist/rnnoise.js` مع تعديل وحيد: استبدال `export default` في السطر الأخير بتصدير يعمل مع `importScripts()` و `require()` |

RNNoise شبكة عصبية متكررة (GRU) صغيرة تعمل على إطارات طولها 10ms بمعدل 48kHz، وتقدّر لكل نطاق ترددي نسبة الكلام إلى الضوضاء، إضافة إلى احتمال وجود كلام (VAD).
