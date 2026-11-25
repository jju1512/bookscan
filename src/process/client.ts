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

/** 단계 하나가 이보다 오래 걸리면 worker 가 멈춘 것으로 본다 */
export const STEP_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 엔진 자체를 쓸 수 없다 (OpenCV 를 못 불러옴, worker 가 죽음·응답 없음).
 * runner 는 이 오류면 페이지를 실패로 표시하지 않고 실행을 멈춘다 (모든 페이지가 "실패"로 굳는 것을 막는다).
 */
export class EngineError extends Error {
  readonly fatal = true;
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
      } else if (m.id === undefined) readyReject(new EngineError(`OpenCV.js 를 불러오지 못했습니다: ${m.message}`));
      else {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        w?.reject(new Error(m.message));
      }
    };
    this.worker.onerror = (e) => {
      const err = new EngineError(`후처리 worker 오류: ${e.message || '알 수 없음'}`);
      readyReject(err);
      this.failAll(err);
    };
    const init: ProcessRequest = { type: 'init', opencvUrl: new URL(opencvUrl(base), location.href).href };
    this.worker.postMessage(init);
  }

  async runImageStep(step: ImageStepName, input: Blob, meta: StepMeta, maxEdge: number): Promise<ImageStepRun> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new EngineError(`${step} 단계가 ${STEP_TIMEOUT_MS / 60000}분 넘게 응답이 없습니다 (메모리 부족일 수 있음)`));
      }, STEP_TIMEOUT_MS);
      this.waiting.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const req: ProcessRequest = { type: 'run', id, step, input, meta, maxEdge };
      this.worker.postMessage(req);
    });
  }

  private failAll(e: Error): void {
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  dispose(): void {
    this.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error('후처리 worker 종료'));
    this.waiting.clear();
  }
}
