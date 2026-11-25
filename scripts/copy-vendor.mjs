/**
 * 외부 런타임 파일을 node_modules 에서 public/vendor/ 로 복사한다 (dev·build 전에 자동 실행).
 * CDN 을 쓰지 않고 같은 출처(GitHub Pages)에서 내려준다 — 이미지가 기기 밖으로 나가지 않고, 오프라인 캐시도 된다.
 * public/vendor/ 는 커밋하지 않는다 (.gitignore).
 *
 * - vendor/opencv/opencv.js           @techstark/opencv-js (단일 스레드 WASM 내장, Apache-2.0)
 * - vendor/tesseract/worker.min.js    tesseract.js worker (Apache-2.0)
 * - vendor/tesseract/*-lstm.wasm.js   tesseract.js-core (LSTM 전용 3종: 기본·SIMD·relaxed SIMD, Apache-2.0)
 * - vendor/tessdata/{kor,eng}.traineddata.gz   @tesseract.js-data (tessdata_best int 변환본, Apache-2.0)
 * - vendor/samples/*.png              합성 테스트 이미지 (/debug/compare 기본 샘플)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor');

const files = [
  ['@techstark/opencv-js/dist/opencv.js', 'opencv/opencv.js'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['@tesseract.js-data/kor/4.0.0_best_int/kor.traineddata.gz', 'tessdata/kor.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tessdata/eng.traineddata.gz'],
];

let copied = 0;
for (const [from, to] of files) {
  const src = join(nm, from);
  const dst = join(out, to);
  if (!existsSync(src)) throw new Error(`없음: ${src} (npm ci 를 먼저)`);
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(dst) && statSync(dst).size === statSync(src).size && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
  copyFileSync(src, dst);
  copied++;
}

const samplesSrc = join(root, 'tests', 'fixtures', 'synthetic');
const samplesDst = join(out, 'samples');
mkdirSync(samplesDst, { recursive: true });
const samples = existsSync(samplesSrc) ? readdirSync(samplesSrc).filter((f) => f.endsWith('.png')).sort() : [];
for (const f of samples) copyFileSync(join(samplesSrc, f), join(samplesDst, f));
writeFileSync(join(samplesDst, 'index.json'), JSON.stringify(samples));
console.log(`vendor: ${copied}개 복사, 샘플 ${samples.length}개 → public/vendor/`);
