/** 분석 worker 를 감싼다. 한 번에 한 프레임만 보낸다 (밀리면 그 프레임은 건너뛴다). */
import type { FrameMetrics } from './analysis';
import type { AnalysisRequest, AnalysisResponse } from './analysis.worker';

export interface MetricsResult extends FrameMetrics {
  ms: number;
}

export class AnalyzerClient {
  private worker: Worker;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (m: MetricsResult) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module', name: 'capture-analysis' });
    this.worker.onmessage = (ev: MessageEvent<AnalysisResponse>) => {
      const m = ev.data;
      if (m.type === 'metrics') {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        w?.resolve({ motion: m.motion, change: m.change, sharpness: m.sharpness, ms: m.ms });
      } else if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        w?.reject(new Error(m.message));
      }
    };
  }

  get busy(): boolean {
    return this.waiting.size > 0;
  }

  analyze(bitmap: ImageBitmap, pixelDiff: number): Promise<MetricsResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.post({ type: 'frame', id, bitmap, pixelDiff }, [bitmap]);
    });
  }

  setReference(): void {
    this.post({ type: 'setReference' });
  }

  setReferenceFrom(bitmap: ImageBitmap, width: number, height: number): void {
    this.post({ type: 'setReferenceFrom', bitmap, width, height }, [bitmap]);
  }

  resetMotion(): void {
    this.post({ type: 'resetMotion' });
  }

  reset(): void {
    this.post({ type: 'reset' });
  }

  terminate(): void {
    this.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error('분석 worker 종료'));
    this.waiting.clear();
  }

  private post(msg: AnalysisRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }
}

/** 미리보기 크기에서 분석 크기 (가로 ANALYSIS_WIDTH, 비율 유지, 짝수) */
export function analysisSize(videoW: number, videoH: number, analysisWidth: number): { width: number; height: number } {
  if (!videoW || !videoH) return { width: analysisWidth, height: Math.round((analysisWidth * 3) / 4) };
  const width = Math.min(analysisWidth, videoW);
  const height = Math.max(2, Math.round((videoH * width) / videoW / 2) * 2);
  return { width, height };
}
