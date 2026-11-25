/**
 * 후처리 worker (SPEC 8장 공통 규칙: worker 하나에서 한 번에 한 페이지씩).
 * OpenCV.js 를 한 번 불러 두고, 메인 스레드가 보내는 단계 요청을 차례로 처리한다.
 */
import { loadOpenCv } from './cvload';
import type { StepMeta } from './step';
import { createSteps, type ImageStepName } from './steps';

export type ProcessRequest =
  | { type: 'init'; opencvUrl: string }
  | { type: 'run'; id: number; step: ImageStepName; input: Blob; meta: StepMeta; maxEdge: number };

export type ProcessResponse =
  | { type: 'ready'; ms: number }
  | { type: 'result'; id: number; image: Blob | null; meta: StepMeta; ms: number }
  | { type: 'error'; id?: number; message: string };

let cvPromise: Promise<unknown> | null = null;
let queue: Promise<void> = Promise.resolve();

const post = (m: ProcessResponse) => (self as unknown as { postMessage(m: ProcessResponse): void }).postMessage(m);

self.onmessage = (ev: MessageEvent<ProcessRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    const t0 = performance.now();
    cvPromise = loadOpenCv(msg.opencvUrl);
    cvPromise.then(
      () => post({ type: 'ready', ms: performance.now() - t0 }),
      (e: unknown) => post({ type: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return;
  }
  // 한 번에 하나씩 (메모리 보호)
  queue = queue.then(async () => {
    const t0 = performance.now();
    try {
      if (!cvPromise) throw new Error('worker 초기화 전입니다');
      const cv = await cvPromise;
      const steps = createSteps(cv, { maxEdge: msg.maxEdge });
      const r = await steps[msg.step].run(msg.input, msg.meta);
      post({ type: 'result', id: msg.id, image: r.image as Blob | null, meta: r.meta, ms: performance.now() - t0 });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: e instanceof Error ? `${e.message}` : String(e) });
    }
  });
};
