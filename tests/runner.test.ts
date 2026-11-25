/**
 * 후처리 실행기: 단계별 저장·이어서 처리·건너뛰기·실패 시 동작 (SPEC 8장 공통 규칙, 9장 저장 내구성).
 * 이미지 단계는 가짜 실행기로 바꾼다 (실제 OpenCV 단계는 process.test.ts).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { ImageStepRun, StepExecutor } from '../src/process/client';
import type { OcrEngine } from '../src/process/ocr/ocr';
import { estimateRemaining, finalImagePath, inputPathFor, ProcessRunner, type RunnerSettings } from '../src/process/runner';
import type { StepMeta } from '../src/process/step';
import type { ImageStepName } from '../src/process/steps';
import { openBookscanDB } from '../src/storage/db';
import { MemoryFileStore } from '../src/storage/files';
import { Repo } from '../src/storage/repo';
import { emptySteps, type Page } from '../src/storage/types';

let n = 0;
async function setup(captures = 2, mode: 'spread' | 'single' = 'spread') {
  const files = new MemoryFileStore();
  let id = 0;
  const repo = new Repo(await openBookscanDB(`test-runner-${++n}`), files, () => 1000, () => `p${n}-${++id}`);
  const book = await repo.createBook({ title: '책', captureMode: mode });
  for (let i = 0; i < captures; i++) await repo.addCapture(book.id, { jpeg: new Blob([`orig${i}`]), thumb: new Blob(['t']), width: 10, height: 10, sharpness: 1 });
  return { repo, book, files };
}

class FakeExec implements StepExecutor {
  calls: { step: ImageStepName; input: string; side: unknown }[] = [];
  failOn = new Set<string>();
  throwOn = new Set<string>();
  /** 이 횟수만큼 부른 뒤 멈춤 요청 (중간에 새로고침 흉내) */
  onCall?: (n: number) => void;
  async runImageStep(step: ImageStepName, input: Blob, meta: StepMeta): Promise<ImageStepRun> {
    const text = await input.text();
    this.calls.push({ step, input: text, side: meta.side });
    this.onCall?.(this.calls.length);
    if (this.throwOn.has(step)) throw new Error(`${step} 터짐`);
    if (step === 'dewarp') return { image: null, meta: { ...meta, outcome: { state: 'skipped', note: '글자 줄 적음' } } as never, ms: 5 };
    if (step === 'finger') return { image: null, meta: { ...meta, overText: true, outcome: { state: 'done' } } as never, ms: 5 };
    const failed = this.failOn.has(step);
    return { image: new Blob([`${step}(${text})`]), meta: { ...meta, corners: [0, 0, 1, 0, 1, 1, 0, 1], splitX: 0.5, outcome: { state: failed ? 'failed' : 'done', note: failed ? '못 찾음' : undefined } } as never, ms: 5 };
  }
  dispose() {}
}

const fakeOcr = (): OcrEngine => ({
  recognize: async (b) => ({ text: `글자:${await b.text()}`, words: [{ t: '글자', x: 0, y: 0, w: 0.1, h: 0.1 }], confidence: 90 }),
  dispose: async () => {},
});

const allOn: RunnerSettings = { steps: { crop: true, finger: true, dewarp: true, enhance: true, ocr: true }, enhanceBinarize: false, maxEdge: 3000 };

describe('후처리 실행기', () => {
  it('페이지마다 단계를 차례로: 앞 단계 결과를 입력으로, 결과는 OPFS 와 Page.steps 에', async () => {
    const { repo, book } = await setup(1);
    const exec = new FakeExec();
    const runner = new ProcessRunner({ repo, executor: exec, ocr: fakeOcr, settings: () => allOn });
    expect(await runner.run(book.id)).toBe(true);
    const pages = await repo.listPages(book.id);
    expect(pages.map((p) => p.side)).toEqual(['left', 'right']);
    const p = pages[0]!;
    expect(p.steps).toEqual({ crop: 'done', finger: 'done', dewarp: 'skipped', enhance: 'done', ocr: 'done' });
    expect(p.notes?.dewarp).toBe('글자 줄 적음');
    expect(p.fingerOverText).toBe(true);
    expect(p.auto?.splitX).toBe(0.5);
    // finger·dewarp 는 이미지를 바꾸지 않았으므로 enhance 입력은 crop 결과
    expect(exec.calls.filter((c) => c.side === 'left').map((c) => `${c.step}:${c.input}`)).toEqual([
      'crop:orig0',
      'finger:crop(orig0)',
      'dewarp:crop(orig0)',
      'enhance:crop(orig0)',
    ]);
    expect(p.ocr?.text).toBe('글자:enhance(crop(orig0))');
    expect(finalImagePath(p)).toBe(p.files.enhance);
    expect((await repo.getBook(book.id))!.processState).toBe('done');
  });

  it('중간에 멈추고(새로고침) 다시 열면 끝나지 않은 단계부터 이어서 한다', async () => {
    const { repo, book, files } = await setup(2);
    const exec = new FakeExec();
    const runner = new ProcessRunner({ repo, executor: exec, ocr: fakeOcr, settings: () => allOn });
    exec.onCall = (k) => {
      if (k === 6) runner.stop();
    };
    expect(await runner.run(book.id)).toBe(false);
    // 사용자가 멈춘 것은 idle (화면을 다시 열어도 저절로 이어서 하지 않는다). 새로고침으로 끊기면 running 이 남는다
    expect((await repo.getBook(book.id))!.processState).toBe('idle');
    // 새로고침: DB 를 다시 열고 recover
    const repo2 = new Repo(await openBookscanDB(`test-runner-${n}`), files, () => 2000, () => `q${n}-${Math.random()}`);
    await repo2.recover();
    const before = exec.calls.length;
    const exec2 = new FakeExec();
    const runner2 = new ProcessRunner({ repo: repo2, executor: exec2, ocr: fakeOcr, settings: () => allOn });
    expect(await runner2.run(book.id)).toBe(true);
    // 이미 끝난 단계는 다시 하지 않는다: 전체 호출 수 = 4 페이지 × 4 이미지 단계
    expect(before + exec2.calls.length).toBe(16);
    const pages = await repo2.listPages(book.id);
    expect(pages.every((p) => p.steps.ocr === 'done')).toBe(true);
  });

  it('설정에서 끈 단계와 페이지별 건너뛰기는 skipped', async () => {
    const { repo, book } = await setup(1, 'single');
    const [page] = await repo.ensurePages(book.id);
    await repo.updatePage(page!.id, (p) => ({ ...p, skip: ['finger'] }));
    const exec = new FakeExec();
    const runner = new ProcessRunner({ repo, executor: exec, ocr: fakeOcr, settings: () => ({ ...allOn, steps: { ...allOn.steps, ocr: false } }) });
    await runner.run(book.id);
    const p = (await repo.getPage(page!.id))!;
    expect(p.steps.finger).toBe('skipped');
    expect(p.notes?.finger).toBe('이 페이지는 건너뜀');
    expect(p.steps.ocr).toBe('skipped');
    expect(p.notes?.ocr).toBe('설정에서 끈 단계');
    expect(exec.calls.map((c) => c.step)).toEqual(['crop', 'dewarp', 'enhance']);
  });

  it('자르기 실패 → failed + 수동 보정 필요 표시, 다음 단계는 그 결과(원본 유지)로 계속', async () => {
    const { repo, book } = await setup(1, 'single');
    const exec = new FakeExec();
    exec.failOn.add('crop');
    await new ProcessRunner({ repo, executor: exec, ocr: fakeOcr, settings: () => allOn }).run(book.id);
    const [p] = await repo.listPages(book.id);
    expect(p!.steps.crop).toBe('failed');
    expect(p!.needsManual).toBe(true);
    expect(p!.notes?.crop).toBe('못 찾음');
    expect(p!.steps.enhance).toBe('done');
  });

  it('단계가 예외를 던져도 failed 로 남기고 앞 결과로 계속 (보정 실패 → 이전 결과, OCR 실패 → 텍스트 없음)', async () => {
    const { repo, book } = await setup(1, 'single');
    const exec = new FakeExec();
    exec.throwOn.add('enhance');
    const badOcr = (): OcrEngine => ({ recognize: async () => { throw new Error('OCR 실패'); }, dispose: async () => {} });
    await new ProcessRunner({ repo, executor: exec, ocr: badOcr, settings: () => allOn }).run(book.id);
    const [p] = await repo.listPages(book.id);
    expect(p!.steps.enhance).toBe('failed');
    expect(p!.notes?.enhance).toMatch('enhance 터짐');
    expect(p!.steps.ocr).toBe('failed');
    expect(p!.ocr).toBeUndefined();
    expect(finalImagePath(p!)).toBe(p!.files.crop);
  });

  it('엔진 오류(OpenCV 못 불러옴·worker 죽음)면 페이지를 실패로 굳히지 않고 멈춘다', async () => {
    const { repo, book } = await setup(1, 'single');
    const exec = new FakeExec();
    exec.runImageStep = async () => {
      throw Object.assign(new Error('OpenCV.js 를 불러오지 못했습니다'), { fatal: true });
    };
    await expect(new ProcessRunner({ repo, executor: exec, ocr: fakeOcr, settings: () => allOn }).run(book.id)).rejects.toThrow('OpenCV');
    const [p] = await repo.listPages(book.id);
    expect(p!.steps.crop).toBe('pending');
    expect(p!.needsManual).toBeUndefined();
  });

  it('결과 나쁜 페이지만 다시 처리 (resetPageSteps + pageIds)', async () => {
    const { repo, book } = await setup(2, 'single');
    const exec = new FakeExec();
    const runner = new ProcessRunner({ repo, executor: exec, ocr: fakeOcr, settings: () => allOn });
    await runner.run(book.id);
    const [, second] = await repo.listPages(book.id);
    await repo.resetPageSteps(second!.id, 'enhance');
    exec.calls = [];
    await runner.run(book.id, { pageIds: [second!.id] });
    expect(exec.calls.map((c) => c.step)).toEqual(['enhance']);
  });

  it('남은 시간 추정과 입력 경로', () => {
    const base: Page = { id: 'x', bookId: 'b', captureId: 'c', side: 'single', order: 1, steps: emptySteps(), files: {} };
    const done: Page = { ...base, steps: { crop: 'done', finger: 'done', dewarp: 'done', enhance: 'done', ocr: 'done' }, durations: { crop: 100, finger: 50, dewarp: 300, enhance: 80, ocr: 1000 } };
    expect(estimateRemaining([done, base, base], allOn.steps, {})).toBe(2 * 1530);
    expect(estimateRemaining([base], allOn.steps, {})).toBeUndefined();
    expect(inputPathFor({ ...base, files: { crop: 'a', dewarp: 'c' } }, 'enhance')).toBe('c');
    expect(inputPathFor({ ...base, files: { crop: 'a', dewarp: 'c' } }, 'finger')).toBe('a');
    expect(inputPathFor(base, 'crop')).toBeNull();
  });
});
