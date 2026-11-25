/** 후처리 worker 와 Tesseract 를 감싼 실행기. 메인 스레드에서 쓴다. */
import { opencvUrl } from './cvload';
import type { ProcessRequest, ProcessResponse } from './process.worker';
import type { StepMeta } from './step';
import type { ImageStepName } from './steps';

export interface ImageStepRun {
  image: Blob | null;
  meta: StepMeta & { outcome?: { state: 'done' | 'skipped' | 'failed'; note?: string } };
  ms: number;
}

/** 이미지 단계(crop/finger/dewarp/enhance) 를 실행하는 쪽. 테스트에서는 가짜로 바꾼다 */
export interface StepExecutor {
  runImageStep(step: ImageStepName, input: Blob, meta: StepMeta, maxEdge: number): Promise<ImageStepRun>;
  dispose(): void;
}

export class WorkerExecutor implements StepExecutor {
  private worker: Worker;
  private ready: Promise<void>;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (r: ImageStepRun) => void; reject: (e: Error) => void }>();

  constructor(base = import.meta.env.BASE_URL) {
    this.worker = new Worker(new URL('./process.worker.ts', import.meta.url), { type: 'module', name: 'process' });
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    this.worker.onmessage = (ev: MessageEvent<ProcessResponse>) => {
      const m = ev.data;
      if (m.type === 'ready') readyResolve();
      else if (m.type === 'result') {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        w?.resolve({ image: m.image, meta: m.meta, ms: m.ms });
      } else if (m.id === undefined) readyReject(new Error(m.message));
      else {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        w?.reject(new Error(m.message));
      }
    };
    this.worker.onerror = (e) => readyReject(new Error(e.message || '후처리 worker 오류'));
    const init: ProcessRequest = { type: 'init', opencvUrl: new URL(opencvUrl(base), location.href).href };
    this.worker.postMessage(init);
  }

  async runImageStep(step: ImageStepName, input: Blob, meta: StepMeta, maxEdge: number): Promise<ImageStepRun> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const req: ProcessRequest = { type: 'run', id, step, input, meta, maxEdge };
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error('후처리 worker 종료'));
    this.waiting.clear();
  }
}
