/**
 * 프레임 분석 worker (SPEC 6장). 메인 스레드는 미리보기를 축소한 ImageBitmap 만 넘긴다.
 * 흑백 변환·블러·차이·라플라시안은 analysis.ts 의 순수 함수로 한다.
 */
import { FrameAnalyzer, rgbaToGray } from './analysis';

export type AnalysisRequest =
  | { type: 'frame'; id: number; bitmap: ImageBitmap; pixelDiff: number }
  | { type: 'setReference' }
  | { type: 'setReferenceFrom'; bitmap: ImageBitmap; width: number; height: number }
  | { type: 'resetMotion' }
  | { type: 'reset' };

export type AnalysisResponse =
  | { type: 'metrics'; id: number; motion: number; change: number; sharpness: number; ms: number; width: number; height: number }
  | { type: 'error'; id?: number; message: string };

const analyzer = new FrameAnalyzer(25);
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function grayOf(bitmap: ImageBitmap, width = bitmap.width, height = bitmap.height) {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new Error('OffscreenCanvas 2d 를 만들 수 없습니다');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const img = ctx.getImageData(0, 0, width, height);
  return rgbaToGray(img.data, width, height);
}

self.onmessage = (ev: MessageEvent<AnalysisRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'frame': {
        const t0 = performance.now();
        analyzer.pixelDiff = msg.pixelDiff;
        const gray = grayOf(msg.bitmap);
        const m = analyzer.analyze(gray);
        const res: AnalysisResponse = { type: 'metrics', id: msg.id, ...m, ms: performance.now() - t0, width: gray.width, height: gray.height };
        self.postMessage(res);
        break;
      }
      case 'setReference':
        analyzer.setReference();
        break;
      case 'setReferenceFrom': {
        const gray = grayOf(msg.bitmap, msg.width, msg.height);
        analyzer.setReferenceFrom(gray, msg.width, msg.height);
        break;
      }
      case 'resetMotion':
        analyzer.resetMotion();
        break;
      case 'reset':
        analyzer.reset();
        break;
    }
  } catch (e) {
    const res: AnalysisResponse = { type: 'error', id: msg.type === 'frame' ? msg.id : undefined, message: e instanceof Error ? e.message : String(e) };
    self.postMessage(res);
  }
};
