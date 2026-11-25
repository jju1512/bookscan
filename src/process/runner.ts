/**
 * 후처리 실행기 (SPEC 8장 공통 규칙).
 * - 책 단위로 페이지를 순서대로, 한 번에 한 페이지씩 처리한다.
 * - 단계가 끝날 때마다 결과를 OPFS 에 쓰고 Page.steps 를 갱신한다. 중단되면 pending 단계부터 이어서 한다
 *   (앱 시작 때 repo.recover() 가 running → pending 으로 되돌린다).
 * - 단계 켜고 끄기(설정), 페이지별 건너뛰기(Page.skip), 실패해도 다음 단계는 앞 결과로 계속한다 (8장 "실패하면" 열).
 */
import type { Repo } from '../storage/repo';
import { PROCESS_STEPS, type Page, type ProcessStepName } from '../storage/types';
import type { StepExecutor } from './client';
import type { OcrEngine } from './ocr/ocr';

export interface RunnerSettings {
  steps: Record<ProcessStepName, boolean>;
  enhanceBinarize: boolean;
  maxEdge: number;
}

export interface RunnerDeps {
  repo: Repo;
  executor: StepExecutor;
  ocr: () => OcrEngine;
  settings: () => RunnerSettings;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

export interface RunProgress {
  pagesTotal: number;
  pagesDone: number;
  stepsTotal: number;
  stepsDone: number;
  current?: { pageId: string; order: number; step: ProcessStepName };
  /** 남은 시간 추정 (ms). 측정값이 없으면 undefined */
  etaMs?: number;
}

/** 단계를 처리할 차례인가 (pending 만. failed/done/skipped 는 사용자가 다시 처리를 고를 때까지 둔다) */
export function needsWork(p: Page): boolean {
  return PROCESS_STEPS.some((s) => p.steps[s] === 'pending' || p.steps[s] === 'running');
}

/** step 에 넣을 이미지 경로: 앞 단계 중 결과 파일이 있는 가장 늦은 것. crop 이 없으면 null (원본을 쓴다) */
export function inputPathFor(p: Page, step: ProcessStepName): string | null {
  const order: ('crop' | 'finger' | 'dewarp' | 'enhance')[] = ['crop', 'finger', 'dewarp', 'enhance'];
  const idx = PROCESS_STEPS.indexOf(step);
  for (let i = Math.min(idx, order.length) - 1; i >= 0; i--) {
    const f = p.files[order[i]!];
    if (f) return f;
  }
  return null;
}

/** 최종 이미지 경로 (PDF·비교 화면용) */
export function finalImagePath(p: Page): string | null {
  return inputPathFor(p, 'ocr');
}

/** 단계별 평균 시간으로 남은 시간 추정 (순수 함수) */
export function estimateRemaining(pages: Page[], enabled: Record<ProcessStepName, boolean>, measured: Partial<Record<ProcessStepName, number[]>>): number | undefined {
  const avg: Partial<Record<ProcessStepName, number>> = {};
  for (const s of PROCESS_STEPS) {
    const m = [...(measured[s] ?? []), ...pages.flatMap((p) => (p.steps[s] === 'done' && p.durations?.[s] ? [p.durations[s]!] : []))];
    if (m.length) avg[s] = m.reduce((a, b) => a + b, 0) / m.length;
  }
  let total = 0;
  for (const p of pages) {
    for (const s of PROCESS_STEPS) {
      if (!enabled[s] || p.skip?.includes(s)) continue;
      if (p.steps[s] !== 'pending' && p.steps[s] !== 'running') continue;
      const a = avg[s];
      if (a === undefined) return undefined;
      total += a;
    }
  }
  return total;
}

export class ProcessRunner {
  private stopRequested = false;
  private active = false;
  private listeners = new Set<(p: RunProgress) => void>();
  private measured: Partial<Record<ProcessStepName, number[]>> = {};

  constructor(private readonly deps: RunnerDeps) {}

  get running(): boolean {
    return this.active;
  }

  onProgress(fn: (p: RunProgress) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stop(): void {
    this.stopRequested = true;
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, data?: unknown) {
    this.deps.log?.(level, msg, data);
  }

  /**
   * 책의 남은 단계를 처리한다. pageIds 를 주면 그 페이지만.
   * 반환값: 끝까지 했으면 true, 중간에 stop() 으로 멈췄으면 false.
   */
  async run(bookId: string, opts: { pageIds?: string[] } = {}): Promise<boolean> {
    if (this.active) throw new Error('이미 처리 중입니다');
    this.active = true;
    this.stopRequested = false;
    const { repo } = this.deps;
    try {
      const book = await repo.getBook(bookId);
      if (!book) throw new Error('책이 없습니다');
      await repo.updateBook(bookId, { processState: 'running' }, false);
      let pages = await repo.ensurePages(bookId);
      if (opts.pageIds) pages = pages.filter((p) => opts.pageIds!.includes(p.id));
      const captures = new Map((await repo.listCaptures(bookId)).map((c) => [c.id, c]));
      const work = pages.filter(needsWork);
      const stepsTotal = work.length * PROCESS_STEPS.length;
      let stepsDone = 0;
      let pagesDone = pages.length - work.length;

      for (const p0 of work) {
        let page = (await repo.getPage(p0.id))!;
        for (const step of PROCESS_STEPS) {
          if (this.stopRequested) return false;
          const st = page.steps[step];
          if (st !== 'pending' && st !== 'running') {
            stepsDone++;
            continue;
          }
          const s = this.deps.settings();
          this.emit({ pagesTotal: pages.length, pagesDone, stepsTotal, stepsDone, current: { pageId: page.id, order: page.order, step }, etaMs: estimateRemaining(await repo.listPages(bookId), s.steps, this.measured) });
          if (!s.steps[step]) {
            page = await repo.saveStepResult(page.id, step, 'skipped', { note: '설정에서 끈 단계' });
          } else if (page.skip?.includes(step)) {
            page = await repo.saveStepResult(page.id, step, 'skipped', { note: '이 페이지는 건너뜀' });
          } else {
            page = await this.runStep(page, step, captures.get(page.captureId)?.file ?? null, s);
          }
          stepsDone++;
        }
        pagesDone++;
      }
      this.emit({ pagesTotal: pages.length, pagesDone, stepsTotal, stepsDone, etaMs: 0 });
      const all = await repo.listPages(bookId);
      if (!all.some(needsWork)) await repo.updateBook(bookId, { processState: 'done', driveMetaDirty: true }, false);
      return true;
    } finally {
      this.active = false;
    }
  }

  private async runStep(page: Page, step: ProcessStepName, originalPath: string | null, s: RunnerSettings): Promise<Page> {
    const { repo, executor } = this.deps;
    page = await repo.updatePage(page.id, (p) => ({ ...p, steps: { ...p.steps, [step]: 'running' } }));
    const t0 = this.now();
    const inPath = step === 'crop' ? originalPath : inputPathFor(page, step) ?? originalPath;
    const input = inPath ? await repo.files.read(inPath) : null;
    if (!input) {
      return repo.saveStepResult(page.id, step, 'failed', { note: '입력 이미지가 없습니다 (원본이 로컬 정리됐으면 드라이브에서 다시 불러오세요)' });
    }
    try {
      if (step === 'ocr') {
        const r = await this.deps.ocr().recognize(input);
        const ms = this.now() - t0;
        this.record(step, ms);
        return repo.saveStepResult(page.id, step, 'done', { durationMs: ms, patch: { ocr: { text: r.text, words: r.words } }, note: r.words.length ? undefined : '인식한 글자가 없습니다' });
      }
      const meta = { bookId: page.bookId, pageId: page.id, side: page.side, manual: page.manual, binarize: s.enhanceBinarize };
      const r = await executor.runImageStep(step, input, meta, s.maxEdge);
      const ms = this.now() - t0;
      const outcome = r.meta.outcome ?? { state: 'done' as const };
      this.record(step, ms);
      const patch: Partial<Page> = {};
      if (step === 'crop') {
        patch.auto = { corners: r.meta.corners as number[] | undefined, splitX: r.meta.splitX as number | undefined };
        patch.needsManual = outcome.state === 'failed';
      }
      if (step === 'finger') patch.fingerOverText = r.meta.overText === true;
      return repo.saveStepResult(page.id, step, outcome.state, { image: r.image ?? undefined, note: outcome.note, durationMs: ms, patch });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('error', `${step} 실패 (페이지 ${page.order})`, msg);
      const patch: Partial<Page> = step === 'crop' ? { needsManual: true } : {};
      // 자르기가 실패하면 원본을 그대로 다음 단계에 넘긴다 (원본 유지 + 수동 보정)
      return repo.saveStepResult(page.id, step, 'failed', { note: `오류: ${msg}`, durationMs: this.now() - t0, patch });
    }
  }

  private record(step: ProcessStepName, ms: number) {
    (this.measured[step] ??= []).push(ms);
  }

  private emit(p: RunProgress) {
    for (const fn of this.listeners) fn(p);
  }
}
